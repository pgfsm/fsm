import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import type { DBDeps } from "@pgfsm/db";
import {
  type AsyncOperationSupportedOp,
  asyncOperationWorkerletHeartbeat,
  asyncOperationWorkerletNotifyChannel,
  claimScheduledForAsyncOperationWorkerlet,
  deregisterAsyncOperationWorkerlet,
  loadAsyncOperation,
  registerAsyncOperationWorkerlet,
} from "@pgfsm/db";
import {
  type ActorPluginValidationResult,
  type ActorReference,
  type OperationLang,
  validateAsyncOperationFromFoldersV2,
  type WorkflowType,
} from "@pgfsm/compiler";
import { startFSMPromiseWorker } from "./fsmpromiseworker.ts";

const logger = getLogger(["@pgfsm/worker", "async-op-workerlet"]);

const _srcDir = new URL(".", import.meta.url).pathname;

const errMsg = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const base = err.stack ?? err.message;
  if (err.cause == null) return base;
  const causeStr = err.cause instanceof Error
    ? (err.cause.stack ?? err.cause.message)
    : String(err.cause);
  return `${base}\nCaused by: ${causeStr}`;
};

const DEFAULT_MAX_CONCURRENCY = 8;
const DRAIN_POLL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 5_000;
const FALLBACK_POLL_INTERVAL_MS = 30_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

type ActiveWorker = { controller: AbortController };

export type AsyncOperationWorkerletHandle = {
  workerletId: string;
  daemon: Promise<void>;
  getActiveQueues: () => string[];
};

export type AsyncOperationWorkerletOptions = {
  signal?: AbortSignal;
  maxConcurrency?: number;
  workerletId?: string;
};

/**
 * Dispatches to the language-appropriate promise worker for a single actor queue.
 * Long-running: runs until signal is aborted or the process exits.
 * - typescript: polls PGMQ via startFSMPromiseWorker
 * - python: spawns subprocess and awaits its exit
 * - go / rust: logs a warning (not yet implemented)
 */
async function startPromiseWorkerForLang(
  result: ActorPluginValidationResult,
  deps: DBDeps,
  queueName: string,
  signal?: AbortSignal,
): Promise<void> {
  const {
    fsmLanguage: lang,
    method: fnName,
    fsmType,
    fsmVersion,
    fsmModulePath,
  } = result;

  if (lang === "typescript") {
    await startFSMPromiseWorker(
      deps,
      queueName,
      fnName,
      fsmType,
      fsmVersion,
      result,
      signal,
    );
  } else if (lang === "python") {
    const scriptPath = `${_srcDir}create-and-start-promise-worker.py`;
    const proc = new Deno.Command("python3", {
      args: [
        scriptPath,
        fsmModulePath,
        fnName,
        queueName,
        fnName,
        fsmType,
        fsmVersion,
      ],
      env: { ...Deno.env.toObject() },
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    logger.info(
      "Started Python promise worker for {fnName} (PID {pid}) on queue {queue}",
      { fnName, pid: proc.pid, queue: queueName },
    );
    signal?.addEventListener("abort", () => proc.kill());
    await proc.status;
  } else {
    logger.warn(
      "Promise worker for lang={lang} not yet implemented (actor={fnName})",
      { lang, fnName },
    );
  }
}

/**
 * Async-operation workerlet — node agent (analogous to fsmlet).
 *
 * On startup:
 *   1. validateAsyncOperationFromFoldersV2 to discover and verify actors.
 *   2. Load each verified async operation into async_operation_meta via loadAsyncOperation.
 *   3. Registers itself in async_operation_workerlet with the full supported-op list.
 *   4. Opens a dedicated LISTEN connection on async_op_workerlet_work_<id>.
 *   5. On each notify: claimScheduledForAsyncOperationWorkerlet() atomically, then
 *      starts a long-running promise worker for that actor queue (one per queue).
 *   6. Heartbeat every 5 s + fallback poll every 30 s to catch missed notifications.
 *
 * Returns immediately with a handle; the daemon runs in the background.
 */
export async function startAsyncOperationWorkerlet(
  deps: DBDeps,
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
  runtimeLanguages: OperationLang[] = [],
  options?: AsyncOperationWorkerletOptions,
): Promise<AsyncOperationWorkerletHandle> {
  const signal = options?.signal;
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const workerletId = options?.workerletId ?? crypto.randomUUID();

  logger.info(
    "AsyncOperationWorkerlet {workerletId} starting (maxConcurrency={max})",
    { workerletId, max: maxConcurrency },
  );

  // Step 1: validate async operations from folders.
  const validationResults = await validateAsyncOperationFromFoldersV2(
    folderPath,
    workflowType,
    skipDirs,
    availableActors,
    runtimeLanguages,
  );

  const verified = validationResults.filter((r) => r.isVerified);
  if (verified.length === 0) {
    throw new Error(
      `AsyncOperationWorkerlet ${workerletId}: no verified async operations found in ${folderPath}. Fix validation errors and retry.`,
    );
  }

  // Step 2: load each verified async operation into async_operation_meta.
  for (const result of verified) {
    try {
      await loadAsyncOperation(
        deps,
        result.method,
        result.fsmVersion,
        result.fsmType,
        result.fsmLanguage,
        result.parentFsmName,
        result.parentFsmVersion,
        workerletId,
      );
      logger.info(
        "AsyncOperationWorkerlet {workerletId}: loaded {method}@{version} (parent={parent}) into DB",
        {
          workerletId,
          method: result.method,
          version: result.fsmVersion,
          parent: result.parentFsmName,
        },
      );
    } catch (err) {
      logger.error(
        "AsyncOperationWorkerlet {workerletId}: failed to load {method}: {error}",
        { workerletId, method: result.method, error: errMsg(err) },
      );
      throw err;
    }
  }

  // Step 3: register in async_operation_workerlet.
  const supportedOps: AsyncOperationSupportedOp[] = verified.map((r) => ({
    async_operation_name: r.method,
    async_operation_version: r.fsmVersion,
    parent_fsm_name: r.parentFsmName,
    parent_fsm_version: r.parentFsmVersion,
  }));
  await registerAsyncOperationWorkerlet(
    deps,
    workerletId,
    supportedOps,
    maxConcurrency,
  );

  const sem = new Semaphore(maxConcurrency);
  const activeWorkers = new Map<string, ActiveWorker>();

  signal?.addEventListener("abort", () => {
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
  });

  // Fire-and-forget: claim one dispatch entry and start a queue-worker for it.
  const processNextWork = async () => {
    await sem.acquire();
    if (signal?.aborted) {
      sem.release();
      return;
    }

    const entry = await claimScheduledForAsyncOperationWorkerlet(
      deps,
      workerletId,
    );
    if (!entry) {
      sem.release();
      return;
    }

    const queueName =
      `${entry.parent_fsm_name}_${entry.async_operation_name}_${entry.parent_fsm_version}`;

    if (activeWorkers.has(queueName)) {
      // Long-running worker already polling this queue — duplicate dispatch, skip.
      sem.release();
      return;
    }

    const result = verified.find(
      (r) =>
        r.method === entry.async_operation_name &&
        r.parentFsmName === entry.parent_fsm_name &&
        r.parentFsmVersion === entry.parent_fsm_version,
    );

    if (!result) {
      logger.warn(
        "AsyncOperationWorkerlet {workerletId}: no verified module for {name} (parent={parent})",
        {
          workerletId,
          name: entry.async_operation_name,
          parent: entry.parent_fsm_name,
        },
      );
      sem.release();
      return;
    }

    const controller = new AbortController();
    activeWorkers.set(queueName, { controller });
    logger.info(
      "AsyncOperationWorkerlet {workerletId}: starting {lang} worker for queue {queue}",
      { workerletId, lang: result.fsmLanguage, queue: queueName },
    );

    startPromiseWorkerForLang(
      result,
      deps,
      queueName,
      controller.signal,
    )
      .catch((err) =>
        logger.error(
          "AsyncOperationWorkerlet {workerletId}: worker for {queue} crashed: {error}",
          { workerletId, queue: queueName, error: errMsg(err) },
        )
      )
      .finally(() => {
        activeWorkers.delete(queueName);
        sem.release();
      });
  };

  // Step 4: dedicated LISTEN connection for work notifications.
  const listenClient = await deps.db.connect();
  const workChannel = asyncOperationWorkerletNotifyChannel(workerletId);
  await listenClient.query(`LISTEN "${workChannel}"`);

  listenClient.on("notification", (msg) => {
    if (msg.channel === workChannel) {
      // Step 5: on each notify, claim atomically then start the worker.
      processNextWork().catch((err) =>
        logger.error(
          "AsyncOperationWorkerlet {workerletId}: processNextWork error: {error}",
          { workerletId, error: errMsg(err) },
        )
      );
    }
  });

  logger.info(
    "AsyncOperationWorkerlet {workerletId}: LISTEN active on {workChannel}",
    { workerletId, workChannel },
  );

  // Step 6: heartbeat + fallback poll loop (the daemon's main blocking task).
  const runHeartbeatAndFallback = async () => {
    let ticksSinceLastFallback = 0;
    const fallbackEveryNHeartbeats = Math.ceil(
      FALLBACK_POLL_INTERVAL_MS / HEARTBEAT_INTERVAL_MS,
    );

    while (!signal?.aborted) {
      await sleep(HEARTBEAT_INTERVAL_MS);
      if (signal?.aborted) break;

      try {
        await asyncOperationWorkerletHeartbeat(
          deps,
          workerletId,
          activeWorkers.size,
        );
      } catch (err) {
        logger.warn(
          "AsyncOperationWorkerlet {workerletId}: heartbeat failed: {error}",
          { workerletId, error: errMsg(err) },
        );
      }

      ticksSinceLastFallback++;
      if (ticksSinceLastFallback >= fallbackEveryNHeartbeats) {
        ticksSinceLastFallback = 0;
        processNextWork().catch((err) =>
          logger.warn(
            "AsyncOperationWorkerlet {workerletId}: fallback poll error: {error}",
            { workerletId, error: errMsg(err) },
          )
        );
      }
    }
  };

  const daemon = runHeartbeatAndFallback().then(async () => {
    // Graceful drain: abort active workers and wait for them to exit.
    for (const { controller } of activeWorkers.values()) {
      controller.abort();
    }
    while (activeWorkers.size > 0) {
      await sleep(DRAIN_POLL_MS);
    }
    listenClient.release();
    await deregisterAsyncOperationWorkerlet(deps, workerletId);
    logger.info("AsyncOperationWorkerlet {workerletId} stopped", {
      workerletId,
    });
  });

  // Drain any work scheduled before LISTEN was active.
  processNextWork().catch((err) =>
    logger.warn(
      "AsyncOperationWorkerlet {workerletId}: initial work check error: {error}",
      { workerletId, error: errMsg(err) },
    )
  );

  return {
    workerletId,
    daemon,
    getActiveQueues: () => [...activeWorkers.keys()],
  };
}

/**
 * Standalone entry point for CLI use. Creates a Pool from dbConfig, starts the
 * workerlet, awaits it, then closes the pool. Prefer `startAsyncOperationWorkerlet`
 * when embedding inside another process so the caller controls pool lifecycle.
 */
export async function runAsyncOperationWorkerlet(
  dbConfig: PoolConfig & { connectionString: string },
  folderPath: string,
  workflowType: WorkflowType,
  options?: AsyncOperationWorkerletOptions,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
  runtimeLanguages: OperationLang[] = [],
): Promise<void> {
  const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const pool = new Pool({
    ...dbConfig,
    max: dbConfig.max ?? maxConcurrency + 4,
  });
  const deps: DBDeps = { db: pool, useSupabase: false };
  const { daemon } = await startAsyncOperationWorkerlet(
    deps,
    folderPath,
    workflowType,
    skipDirs,
    availableActors,
    runtimeLanguages,
    options,
  );
  await daemon;
  await pool.end();
  logger.info("AsyncOperationWorkerlet pool closed.");
}
