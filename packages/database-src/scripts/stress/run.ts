import type { DBDeps } from "@pgfsm/db";
import { createPool } from "./db.ts";
import { ensureFixtureLoaded } from "./fixtures.ts";
import {
  printSummary,
  Recorder,
  type RunResult,
  snapshotPgLocks,
  snapshotPgStatActivity,
  writeResults,
} from "./metrics.ts";
import {
  claimContention,
  instanceCreationBurst,
  macrostepThroughput,
  mixedWorkload,
} from "./scenarios.ts";

const SCENARIOS = ["creation", "macrostep", "claim", "mixed"] as const;
type Scenario = typeof SCENARIOS[number] | "all";

interface Flags {
  scenario: Scenario;
  concurrency: number;
  poolSize: number;
  count: number;
  durationMs: number;
  createPgmqQueue: boolean;
  fsmletPollers: number;
  schedulerPollers: number;
  asyncOpPollers: number;
}

function parseFlags(args: string[]): Flags {
  const raw = new Map<string, string>();
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      throw new Error(`Unrecognized argument: ${arg} (expected --key=value)`);
    }
    raw.set(match[1], match[2]);
  }

  const scenario = (raw.get("scenario") ?? "all") as Scenario;
  if (scenario !== "all" && !SCENARIOS.includes(scenario)) {
    throw new Error(
      `--scenario must be one of: all, ${SCENARIOS.join(", ")}`,
    );
  }

  const concurrency = Number(raw.get("concurrency") ?? 20);
  return {
    scenario,
    concurrency,
    poolSize: Number(raw.get("pool-size") ?? Math.max(concurrency, 10)),
    count: Number(raw.get("count") ?? 500),
    durationMs: Number(raw.get("duration") ?? 15_000),
    createPgmqQueue: raw.get("create-pgmq-queue") === "true",
    fsmletPollers: Number(raw.get("fsmlet-pollers") ?? concurrency),
    schedulerPollers: Number(raw.get("scheduler-pollers") ?? 1),
    asyncOpPollers: Number(raw.get("async-op-pollers") ?? 2),
  };
}

async function runScenario(
  scenario: typeof SCENARIOS[number],
  deps: DBDeps,
  flags: Flags,
): Promise<void> {
  const recorder = new Recorder();
  const startedAt = new Date().toISOString();
  const before = await snapshotPgStatActivity(deps.db);

  const options: Record<string, unknown> = { poolSize: flags.poolSize };

  switch (scenario) {
    case "creation":
      options.count = flags.count;
      options.concurrency = flags.concurrency;
      options.createPgmqQueue = flags.createPgmqQueue;
      await instanceCreationBurst(deps, recorder, {
        count: flags.count,
        concurrency: flags.concurrency,
        createPgmqQueue: flags.createPgmqQueue,
      });
      break;
    case "macrostep":
      options.concurrency = flags.concurrency;
      options.durationMs = flags.durationMs;
      await macrostepThroughput(deps.db, recorder, {
        concurrency: flags.concurrency,
        durationMs: flags.durationMs,
      });
      break;
    case "claim":
      options.fsmletPollers = flags.fsmletPollers;
      options.schedulerPollers = flags.schedulerPollers;
      options.asyncOpPollers = flags.asyncOpPollers;
      options.durationMs = flags.durationMs;
      await claimContention(deps, recorder, {
        fsmletPollerCount: flags.fsmletPollers,
        schedulerPollerCount: flags.schedulerPollers,
        asyncOpWorkerPollerCount: flags.asyncOpPollers,
        durationMs: flags.durationMs,
      });
      break;
    case "mixed":
      options.count = flags.count;
      options.concurrency = flags.concurrency;
      options.durationMs = flags.durationMs;
      await mixedWorkload(deps, deps.db, recorder, {
        creation: {
          count: flags.count,
          concurrency: flags.concurrency,
          createPgmqQueue: flags.createPgmqQueue,
        },
        macrostep: {
          concurrency: flags.concurrency,
          durationMs: flags.durationMs,
        },
        claim: {
          fsmletPollerCount: flags.fsmletPollers,
          schedulerPollerCount: flags.schedulerPollers,
          asyncOpWorkerPollerCount: flags.asyncOpPollers,
          durationMs: flags.durationMs,
        },
      });
      break;
  }

  const finishedAt = new Date().toISOString();
  const after = await snapshotPgStatActivity(deps.db);
  const locks = await snapshotPgLocks(deps.db);

  const result: RunResult = {
    scenario,
    options,
    startedAt,
    finishedAt,
    latency: recorder.summary(),
    pgStatActivityBefore: before,
    pgStatActivityAfter: after,
    pgLocksAfter: locks,
  };
  printSummary(result);
  const path = await writeResults(result);
  console.log(`wrote ${path}`);
}

async function main() {
  const flags = parseFlags(Deno.args);
  const pool = createPool(flags.poolSize);
  const deps: DBDeps = { db: pool, useSupabase: false };

  try {
    await ensureFixtureLoaded(deps);
    const scenarios = flags.scenario === "all" ? SCENARIOS : [flags.scenario];
    for (const scenario of scenarios) {
      await runScenario(scenario, deps, flags);
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
