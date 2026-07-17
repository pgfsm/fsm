import { createActor, waitFor } from "xstate";
import { diff } from "json-diff-ts";
import { assertEquals } from "@std/assert";
import { Pool } from "pg";

import { machineWithProvider } from "./machine-with-provider.ts";
import {
  runAsyncOperationScheduler,
  runFsmScheduler,
  startAsyncOperationWorkerlet,
  startFsmlet,
} from "@pgfsm/worker";
import type {
  AsyncOperationWorkerletHandle,
  FsmletHandle,
} from "@pgfsm/worker";
import {
  createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork,
  createFsmInstanceFromName,
  getFsmDataResolveStateValue,
  sendEventToFsmQueueWithEventLogs,
} from "@pgfsm/db";
import type { DBDeps } from "@pgfsm/db";
import { replaceUnderscoresWithSpaces } from "@pgfsm/compiler";

const fsm_name = "creditCheck";
const fsm_version = "v01";

// validateSyncOperationFromFolders / validateAsyncOperationFromFoldersV2 expect
// the *parent* of per-FSM folders (e.g. ".../fsm", containing "creditCheck/v01").
const FSM_FOLDER_PATH = import.meta.dirname!.split("/").slice(0, -2).join("/");
const SKIP_DIRS = ["carVitals", "taskMachineConfig"];

const SUBMIT_EVENT = {
  type: "Submit" as const,
  SSN: "123-45-6789",
  firstName: "John",
  lastName: "Doe",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stateHasKey(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) {
    return value === key;
  }
  const creditCheck = (value as Record<string, unknown>).creditCheck;
  if (typeof creditCheck === "string") return creditCheck === key;
  if (typeof creditCheck === "object" && creditCheck !== null) {
    return key in (creditCheck as Record<string, unknown>);
  }
  return false;
}

// Poll getFsmDataResolveStateValue until the resolved (space-form) state value
// satisfies predicate, or timeout. Returns the full data payload so callers can
// reuse it for the context/state diff assertions without a second query.
// deno-lint-ignore no-explicit-any
async function pollUntilState(
  deps: DBDeps,
  instanceId: string,
  predicate: (value: unknown) => boolean,
  timeoutMs = 20000,
  intervalMs = 300,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await getFsmDataResolveStateValue(deps, instanceId);
    const machine = data?.resolved_state_value?.json?.machine;
    if (machine) {
      const value = replaceUnderscoresWithSpaces(machine);
      if (predicate(value)) return data;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timeout: state predicate not satisfied for instance "${instanceId}"`,
  );
}

function assertStateAndContextMatch(
  // deno-lint-ignore no-explicit-any
  data: any,
  // deno-lint-ignore no-explicit-any
  xstateSnapshot: any,
) {
  const dbStateWithSpaces = replaceUnderscoresWithSpaces(
    data.resolved_state_value.json.machine,
  );
  const stateChanges = diff(dbStateWithSpaces, xstateSnapshot.value);

  const dbContext = data.fsm_instance_row.fsm_instance_context;
  const contextChanges = diff(dbContext, xstateSnapshot.context);

  assertEquals(
    stateChanges.length,
    0,
    `State mismatch.\nDB: ${JSON.stringify(dbStateWithSpaces)}\nXState: ${
      JSON.stringify(xstateSnapshot.value)
    }\nDiff: ${JSON.stringify(stateChanges, null, 2)}`,
  );

  assertEquals(
    contextChanges.length,
    0,
    `Context mismatch.\nDB: ${JSON.stringify(dbContext)}\nXState: ${
      JSON.stringify(xstateSnapshot.context)
    }\nDiff: ${JSON.stringify(contextChanges, null, 2)}`,
  );
}

type Fleet = {
  pool: Pool;
  deps: DBDeps;
  controller: AbortController;
  fsmletHandle: FsmletHandle;
  asyncOpWorkerletHandle: AsyncOperationWorkerletHandle;
  fsmSchedulerDone: Promise<void>;
  asyncOpSchedulerDone: Promise<void>;
};

// Boots the bounded-fleet stack (fsmscheduler + fsmlet + asyncOperationScheduler
// + asyncOperationWorkerlet) for a single test, isolated via fresh random
// fsmlet/workerlet ids. Awaits fsmlet/workerlet startup so their LISTEN
// connections are active before the caller creates an FSM instance — the
// schedulers are fire-and-forget (they block until aborted), so we give their
// LISTEN setup a brief grace period before returning.
async function startFleet(): Promise<Fleet> {
  const connectionString = Deno.env.get("DATABASE_URL")!;
  const dbConfig = { connectionString };

  const pool = new Pool({ connectionString });
  const deps: DBDeps = { useSupabase: false, db: pool };
  const controller = new AbortController();

  const fsmSchedulerDone = runFsmScheduler(dbConfig, {
    signal: controller.signal,
  });
  const asyncOpSchedulerDone = runAsyncOperationScheduler(dbConfig, {
    signal: controller.signal,
  });
  // Give the schedulers' LISTEN connections a moment to establish before we
  // start creating dispatch-triggering work — they don't expose a readiness
  // signal separate from their (never-resolving-until-abort) run promise.
  await sleep(500);

  const fsmletHandle = await startFsmlet(
    dbConfig,
    { fsm: { folderPath: FSM_FOLDER_PATH, skipDirs: SKIP_DIRS } },
    { signal: controller.signal, asyncOperationVerificationMode: "none" },
  );

  const asyncOpWorkerletHandle = await startAsyncOperationWorkerlet(
    deps,
    FSM_FOLDER_PATH,
    "promise",
    SKIP_DIRS,
    [],
    ["typescript"],
    { signal: controller.signal },
  );

  return {
    pool,
    deps,
    controller,
    fsmletHandle,
    asyncOpWorkerletHandle,
    fsmSchedulerDone,
    asyncOpSchedulerDone,
  };
}

async function stopFleet(fleet: Fleet): Promise<void> {
  fleet.controller.abort();
  await Promise.allSettled([
    fleet.fsmSchedulerDone,
    fleet.asyncOpSchedulerDone,
    fleet.fsmletHandle.daemon,
    fleet.asyncOpWorkerletHandle.daemon,
  ]);
  // startFsmlet creates its own pool internally — caller owns closing it.
  await fleet.fsmletHandle.pool?.end();
  await fleet.pool.end();
}

// Journey 1: createActor initial context matches DB initial context after the
// fleet (fsmscheduler + fsmlet) dispatches and runs the initial transition.
Deno.test({
  name: "Fleet Journey 1 — fsmscheduler + fsmlet: initial context matches",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const input_fsm_context = {
      SSN: "123-45-6789",
      FirstName: "John",
      LastName: "Doe",
      GavUnionScore: 0,
      EquiGavinScore: 0,
      GavperianScore: 0,
      ErrorMessage: "",
      MiddleScore: 0,
      InterestRateOptions: [],
    };

    const fleet = await startFleet();
    const actor = createActor(machineWithProvider, {
      input: input_fsm_context,
    });
    actor.start();

    try {
      const xstateSnapshot = actor.getSnapshot();

      // createFsmInstanceFromName auto-enqueues to fsm_dispatch_queue and
      // notifies fsm_scheduler_work — the fsmlet claims and runs it.
      const fsm_instance = await createFsmInstanceFromName(
        fleet.deps,
        fsm_name,
        fsm_version,
        input_fsm_context,
        true,
        // deno-lint-ignore no-explicit-any
      ) as any;

      if (!fsm_instance?.fsm_instance_id) {
        throw new Error("Failed to create FSM instance");
      }

      const data = await pollUntilState(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        (value) => stateHasKey(value, "Entering Information"),
      );

      assertStateAndContextMatch(data, xstateSnapshot);
    } finally {
      actor.stop();
      await stopFleet(fleet);
    }
  },
});

// Journey 2: Submit event — xstate actor context matches DB context after the
// fsmlet processes the Submit event routed via fsmscheduler dispatch.
Deno.test({
  name: "Fleet Journey 2 — Submit: xstate actor context matches DB context",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const input_fsm_context = {
      SSN: "123-45-6789",
      FirstName: "John",
      LastName: "Doe",
      GavUnionScore: 0,
      EquiGavinScore: 0,
      GavperianScore: 0,
      ErrorMessage: "",
      MiddleScore: 0,
      InterestRateOptions: [],
    };

    const fleet = await startFleet();
    const actor = createActor(machineWithProvider, {
      input: input_fsm_context,
    });
    actor.start();

    try {
      const fsm_instance = await createFsmInstanceFromName(
        fleet.deps,
        fsm_name,
        fsm_version,
        input_fsm_context,
        true,
        // deno-lint-ignore no-explicit-any
      ) as any;

      if (!fsm_instance?.fsm_instance_id) {
        throw new Error("Failed to create FSM instance");
      }

      // Wait for the initial transition to land before sending Submit.
      await pollUntilState(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        (value) => stateHasKey(value, "Entering Information"),
      );

      actor.send(SUBMIT_EVENT);
      const xstateSnapshot = actor.getSnapshot();

      await sendEventToFsmQueueWithEventLogs(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        fsm_instance.fsm_instance_type,
        fsm_instance.fsm_instance_version,
        null,
        null,
        null,
        "Submit",
        "external",
        { type: "Submit", payload: {} },
        0,
      );

      const data = await pollUntilState(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        (value) => stateHasKey(value, "Verifying Credentials"),
      );

      assertStateAndContextMatch(data, xstateSnapshot);
    } finally {
      actor.stop();
      await stopFleet(fleet);
    }
  },
});

// Journey 3: verifyCredentials resolves — asyncOperationScheduler routes the
// verifyCredentials dispatch to asyncOperationWorkerlet, which polls the
// per-actor pgmq queue (creditCheck_v01_verifyCredentials, auto-created by the
// DB layer once Submit is processed) and drives the FSM into
// CheckingCreditScores.
//
// NOTE: unlike the main FSM instance (auto-dispatched by
// create_fsm_instance_from_name_v2), nothing in fsmworker/fsmworker-helper
// currently creates an async-operation dispatch entry when a transition
// invokes a promise actor — so this test dispatches it explicitly, mirroring
// what the `async-operation-ctl.ts dispatch` CLI command does. This must
// happen *after* Submit has been processed (so the per-actor pgmq queue
// exists) — startFSMPromiseWorker exits immediately with no retry if the
// queue is missing when the workerlet claims the dispatch.
Deno.test({
  name:
    "Fleet Journey 3 — verifyCredentials done: xstate actor context matches DB context in CheckingCreditScores",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const input_fsm_context = {
      SSN: "123-45-6789",
      FirstName: "John",
      LastName: "Doe",
      GavUnionScore: 0,
      EquiGavinScore: 0,
      GavperianScore: 0,
      ErrorMessage: "",
      MiddleScore: 0,
      InterestRateOptions: [],
    };

    const fleet = await startFleet();
    const actor = createActor(machineWithProvider, {
      input: input_fsm_context,
    });
    actor.start();

    try {
      actor.send(SUBMIT_EVENT);
      const xstateSnapshot = await waitFor(
        actor,
        (s) => {
          const value = s.value as Record<string, unknown>;
          const creditCheck = value.creditCheck;
          return (
            typeof creditCheck === "object" &&
            creditCheck !== null &&
            "CheckingCreditScores" in (creditCheck as Record<string, unknown>)
          );
        },
        { timeout: 5000 },
      );

      const fsm_instance = await createFsmInstanceFromName(
        fleet.deps,
        fsm_name,
        fsm_version,
        input_fsm_context,
        true,
        // deno-lint-ignore no-explicit-any
      ) as any;

      if (!fsm_instance?.fsm_instance_id) {
        throw new Error("Failed to create FSM instance");
      }

      await pollUntilState(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        (value) => stateHasKey(value, "Entering Information"),
      );

      await sendEventToFsmQueueWithEventLogs(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        fsm_instance.fsm_instance_type,
        fsm_instance.fsm_instance_version,
        null,
        null,
        null,
        "Submit",
        "external",
        { type: "Submit", payload: {} },
        0,
      );

      // Confirms the fsmlet has processed Submit and the per-actor pgmq queue
      // (creditCheck_v01_verifyCredentials) now exists.
      await pollUntilState(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        (value) => stateHasKey(value, "Verifying Credentials"),
      );

      await createAsyncOperationInstanceAndNotifyAsyncOperationSchedulerWork(
        fleet.deps,
        {
          asyncOperationInstanceId: crypto.randomUUID(),
          asyncOperationName: "verifyCredentials",
          asyncOperationVersion: fsm_version,
          asyncOperationType: "promise",
          parentFsmName: fsm_name,
          parentFsmVersion: fsm_version,
          asyncOperationLanguage: "typescript",
        },
      );

      const data = await pollUntilState(
        fleet.deps,
        fsm_instance.fsm_instance_id,
        (value) => stateHasKey(value, "CheckingCreditScores"),
        40000,
      );

      assertStateAndContextMatch(data, xstateSnapshot);
    } finally {
      actor.stop();
      await stopFleet(fleet);
    }
  },
});
