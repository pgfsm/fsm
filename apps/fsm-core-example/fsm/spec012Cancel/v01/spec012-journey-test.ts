// SPEC-012's end-to-end acceptance (#545), on the real stack from repository
// source: the pg_cron-equivalent scheduler, an fsmlet, the Activity Gateway
// (sidecar, poll loop, cancel detection), and one worker per language: the
// TypeScript ActorWorker in process, and test-apps/debug-only's Python, Rust
// and Go workers as subprocesses (each on the published 0.4 SDK).
//
// For each language, a spec012Cancel instance (see its machine.ts) enters the
// state that invokes that language's actor, and the state's 1.5s timer exits
// it while the actor is still working (5s). Then:
//
// - the instance ends in Abandoned and never reaches Finished: no late actor
//   event is processed;
// - the gateway recorded the worker's reply to its cancel as
//   cancel_acknowledged with reason STATE_EXITED and outcome "aborted": the
//   handler observed its token and stopped (SPEC-012 (c));
// - the actor's side effect, a marker file it writes only if it wasn't
//   cancelled, never appears, even after the 5s it would have taken.
//
// Needs DATABASE_URL, plus uv, cargo and go on PATH for the Python, Rust and
// Go workers. SPEC012_LANGUAGES (comma-separated) narrows the languages run.

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";

import { runFsmScheduler } from "@pgfsm/ctl";
import { type FsmletHandle, startFsmlet } from "@pgfsm/sync-worker";
import { startActivityGatewayServer } from "@pgfsm/async-worker-gateway";
import { ActorWorker } from "@pgfsm/async-worker-sdk";
import {
  createFsmInstanceFromName,
  type DBDeps,
  loadFsmDefinitions,
  sendEventToFsmQueueWithEventLogs,
} from "@pgfsm/db";
import {
  FSM_DEFINITIONS,
  SYNC_OPERATION_REGISTRATIONS,
} from "../../../../../test-apps/debug-only/sync-worker/typescript/sync-operation-registry-aggregate.generated.ts";
import { ACTOR_REGISTRATIONS as TS_ACTORS } from "../../../../../test-apps/debug-only/async-worker/typescript/spec012Cancel/v01/actor-registry.generated.ts";
import fsmJson from "../../../../../test-apps/debug-only/sync-worker/typescript/spec012Cancel/v01/fsm.json" with {
  type: "json",
};

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const FSM = "spec012Cancel";
const VERSION = "v01";
const ASYNC_WORKER_DIR = new URL(
  "../../../../../test-apps/debug-only/async-worker/",
  import.meta.url,
).pathname;

type Language = "typescript" | "python" | "rust" | "go";
const SHORT: Record<Language, string> = {
  typescript: "Ts",
  python: "Py",
  rust: "Rs",
  go: "Go",
};
const LANGUAGES = (Deno.env.get("SPEC012_LANGUAGES") ??
  "typescript,python,rust,go").split(",").map((l) => l.trim()) as Language[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isSpec012 = (d: { fsmName: string; fsmVersion: string }) =>
  d.fsmName === FSM && d.fsmVersion === VERSION;

/** A worker subprocess, started once its SDK logs that it registered. */
async function spawnWorker(
  language: Exclude<Language, "typescript">,
  socket: string,
): Promise<Deno.ChildProcess> {
  const cwd = `${ASYNC_WORKER_DIR}${language}`;
  const start = [
    "start",
    "--gateway-socket",
    socket,
    "--worker-id",
    `spec012-${language}`,
  ];
  let command: string;
  let args: string[];
  if (language === "python") {
    command = "uv";
    args = ["run", "python", "run_async_worker.py", ...start];
  } else if (language === "go") {
    command = "go";
    args = ["run", ".", ...start];
  } else {
    const build = await new Deno.Command("cargo", {
      args: ["build", "-q"],
      cwd,
      stdout: "null",
      stderr: "inherit",
    }).output();
    assert(build.success, "cargo build of the Rust worker failed");
    command = `${cwd}/target/debug/run-async-worker`;
    args = start;
  }
  const child = new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Each SDK logs "... registered N actor(s) with the gateway" (Go: "worker
  // registered actors ...") once its Session is acked.
  let registered!: () => void;
  const ready = new Promise<void>((r) => (registered = r));
  for (const stream of [child.stdout, child.stderr]) {
    (async () => {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        if (/registered.*actor/i.test(buffered)) registered();
        buffered = buffered.slice(-500);
      }
    })().catch(() => {});
  }
  const deadline = sleep(180_000).then(() => {
    throw new Error(`the ${language} worker never registered`);
  });
  await Promise.race([ready, deadline]);
  return child;
}

interface Fleet {
  pool: Pool;
  deps: DBDeps;
  controller: AbortController;
  fsmlet: FsmletHandle;
  tsWorker?: ActorWorker;
  children: Deno.ChildProcess[];
  done: Promise<unknown>[];
}

async function startFleet(): Promise<Fleet> {
  const connectionString = DATABASE_URL!;
  const pool = new Pool({ connectionString, max: 4 });
  const deps: DBDeps = { useSupabase: false, db: pool };
  const controller = new AbortController();

  await loadFsmDefinitions(deps, [
    { fsmName: FSM, fsmVersion: VERSION, fsmJson },
  ]);
  const scheduler = runFsmScheduler({ connectionString }, {
    signal: controller.signal,
  });
  await sleep(500);
  const fsmlet = await startFsmlet(
    { connectionString },
    SYNC_OPERATION_REGISTRATIONS.filter(isSpec012),
    FSM_DEFINITIONS.filter(isSpec012),
    { signal: controller.signal },
  );

  const runId = crypto.randomUUID().slice(0, 8);
  const socket = `/tmp/pgfsm-spec012-workers-${runId}.sock`;
  const gateway = startActivityGatewayServer({
    bindTarget: `unix:/tmp/pgfsm-spec012-gateway-${runId}.sock`,
    sidecarSocketPath: socket,
    signal: controller.signal,
    asyncOpPollLoop: { deps, intervalMs: 200 },
    ensureQueueOnRegister: { deps },
    // A state exit reaches the gateway by LISTEN, and by the sweep.
    cancelDetection: {
      deps,
      listenDbUrl: connectionString,
      sweepIntervalMs: 1_000,
    },
  });
  await sleep(500);

  const done: Promise<unknown>[] = [scheduler, fsmlet.daemon, gateway];
  let tsWorker: ActorWorker | undefined;
  if (LANGUAGES.includes("typescript")) {
    tsWorker = new ActorWorker(
      {
        workerId: "spec012-typescript",
        language: "typescript",
        gatewaySocketPath: socket,
      },
      [...TS_ACTORS],
    );
    done.push(tsWorker.run());
  }
  const children: Deno.ChildProcess[] = [];
  for (const language of LANGUAGES) {
    if (language !== "typescript") {
      children.push(await spawnWorker(language, socket));
    }
  }
  await sleep(1_000);
  return { pool, deps, controller, fsmlet, tsWorker, children, done };
}

async function stopFleet(fleet: Fleet): Promise<void> {
  for (const child of fleet.children) {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  }
  await Promise.allSettled(fleet.children.map((c) => c.status));
  fleet.tsWorker?.stop();
  fleet.controller.abort();
  await Promise.allSettled(fleet.done);
  await fleet.fsmlet.pool?.end();
  await fleet.pool.end();
}

async function stateOf(pool: Pool, id: string): Promise<string> {
  const { rows } = await pool.query<{ state: unknown }>(
    `SELECT fsm_instance_state AS state FROM fsm_core.fsm_instance WHERE id = $1::uuid`,
    [id],
  );
  return JSON.stringify(rows[0]?.state ?? null);
}

async function waitForState(pool: Pool, id: string, state: string) {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    last = await stateOf(pool, id);
    if (last.includes(`"${state}"`)) return;
    await sleep(200);
  }
  throw new Error(`instance ${id} never reached ${state}; last state ${last}`);
}

/** The cancel acknowledgements of `language`'s actor since `since`. */
async function cancelAcks(
  pool: Pool,
  language: Language,
  since: Date,
): Promise<{ reason: string; outcome: string }[]> {
  const { rows } = await pool.query<{ reason: string; outcome: string }>(
    `SELECT event_data->>'reason' AS reason, event_data->>'outcome' AS outcome
     FROM fsm_core.fsm_async_operation_queue_event_logs
     WHERE async_operation_queue_name = fsm_core.compute_async_operation_queue_name_v2(
             $1, $2, 'internalAsyncOperation', $3, $2, $4)
       AND event_status = 'cancel_acknowledged'
       AND execution_finished_at >= $5`,
    [FSM, VERSION, `spec012Work${SHORT[language]}`, language, since],
  );
  return rows;
}

/** Actor result events an instance's queue ever received. */
async function actorEvents(pool: Pool, id: string): Promise<string[]> {
  const { rows } = await pool.query<{ event_name: string }>(
    `SELECT event_name FROM fsm_core.fsm_instance_queue_event_logs
     WHERE fsm_instance_id = $1::uuid
       AND (event_name LIKE 'xstate.done.actor.%' OR event_name LIKE 'xstate.error.actor.%')`,
    [id],
  );
  return rows.map((r) => r.event_name);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name:
    "SPEC-012 end-to-end: a state exit aborts the running actor handler in each language (#545)",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const markers = await Deno.makeTempDir({ prefix: "pgfsm-spec012-" });
    const fleet = await startFleet();
    const { pool, deps } = fleet;
    try {
      const since = new Date();
      // Every language at once: each instance enters its language's state.
      const runs = await Promise.all(LANGUAGES.map(async (language) => {
        const markerPath = `${markers}/${language}.marker`;
        const created = await createFsmInstanceFromName(deps, FSM, VERSION, {
          markerPath,
        }) as { fsm_instance_id: string };
        const id = created.fsm_instance_id;
        await waitForState(pool, id, "Idle");
        await sendEventToFsmQueueWithEventLogs(
          deps,
          id,
          FSM,
          VERSION,
          `START_${SHORT[language].toUpperCase()}`,
          "external",
          {},
          0,
        );
        return { language, id, markerPath };
      }));

      for (const run of runs) {
        await waitForState(pool, run.id, "Abandoned");
      }
      // Past the 5s the actors would have worked, plus delivery margin.
      await sleep(7_000);

      for (const { language, id, markerPath } of runs) {
        await t.step(language, async () => {
          const acks = await cancelAcks(pool, language, since);
          assertEquals(
            acks,
            [{ reason: "STATE_EXITED", outcome: "aborted" }],
            `${language}: the handler should have observed its token and stopped`,
          );
          assertEquals(
            await fileExists(markerPath),
            false,
            `${language}: the side effect after the token check happened`,
          );
          const state = await stateOf(pool, id);
          assert(
            state.includes('"Abandoned"'),
            `${language}: ended in ${state}`,
          );
          assert(!state.includes('"Finished"'));
          assertEquals(
            await actorEvents(pool, id),
            [],
            `${language}: a late actor event reached the instance`,
          );
        });
      }
    } finally {
      await stopFleet(fleet);
      await Deno.remove(markers, { recursive: true }).catch(() => {});
    }
  },
});
