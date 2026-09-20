import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import process from "node:process";

// SIGINT/SIGTERM only — the two signals this module actually forwards. A
// narrower type than NodeJS.Signals so this file doesn't need @types/node
// just to describe the two values it uses.
export type SupervisorSignal = "SIGINT" | "SIGTERM";

export interface ProcessSpec {
  /** Human-readable name used in log/error output — not the argv[0]. */
  name: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RunningProcess {
  spec: ProcessSpec;
  child: ChildProcess;
  // Resolves once, when the child exits, however it exits.
  status: Promise<{ code: number }>;
}

type RaceResult =
  | { kind: "signal"; signal: SupervisorSignal }
  | { kind: "exit"; spec: ProcessSpec; code: number };

function spawnChild(spec: ProcessSpec): RunningProcess {
  const child = spawn(spec.cmd, spec.args ?? [], {
    // Deno.Command's `env` option merges into the inherited environment
    // rather than replacing it; node:child_process's `spawn` replaces it
    // outright whenever `env` is set, so replicate the merge explicitly.
    env: spec.env ? { ...process.env, ...spec.env } : undefined,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const status = new Promise<{ code: number }>((resolve) => {
    child.on("exit", (code, signal) => {
      // A signal-terminated child reports code === null; there's no exit
      // code to surface, so treat it as a generic failure (1).
      resolve({ code: code ?? (signal ? 1 : 0) });
    });
  });
  return { spec, child, status };
}

function killAll(children: RunningProcess[], signal: SupervisorSignal): void {
  for (const { child } of children) {
    try {
      child.kill(signal);
    } catch {
      // already exited between the race resolving and this loop running
    }
  }
}

/**
 * Core spawn/race logic, decoupled from OS signal delivery so it can be
 * exercised in tests without sending real signals to the test process.
 * `shutdownSignal` resolves when an external caller wants a graceful
 * shutdown (e.g. real SIGINT/SIGTERM wired up by `runSupervised`).
 */
export async function runProcessGroup(
  specs: ProcessSpec[],
  shutdownSignal: Promise<SupervisorSignal>,
): Promise<number> {
  if (specs.length === 0) {
    throw new Error("runProcessGroup requires at least one process");
  }

  const children = specs.map(spawnChild);

  const exited = Promise.race(
    children.map(({ spec, status }) =>
      status.then(({ code }): RaceResult => ({ kind: "exit", spec, code }))
    ),
  );
  const signaled = shutdownSignal.then((signal): RaceResult => ({
    kind: "signal",
    signal,
  }));

  const winner = await Promise.race([exited, signaled]);

  if (winner.kind === "signal") {
    killAll(children, winner.signal);
    await Promise.allSettled(children.map((c) => c.status));
    return 0;
  }

  // A child exited on its own before shutdown was requested — fail fast and
  // tear down the rest, rather than leaving a silently half-dead stack up.
  console.error(
    `[devstack] "${winner.spec.name}" exited unexpectedly (code ${winner.code}); shutting down remaining processes`,
  );
  killAll(children, "SIGTERM");
  await Promise.allSettled(children.map((c) => c.status));
  return winner.code === 0 ? 1 : winner.code;
}

export interface RunSupervisedOptions {
  /** OS signals that trigger a graceful shutdown. Defaults to SIGINT/SIGTERM. */
  signals?: SupervisorSignal[];
}

/**
 * Spawns every process in `specs`, forwards SIGINT/SIGTERM to all of them on
 * shutdown, and fails fast (tearing down the rest) if any child exits on its
 * own first. Resolves with the process's exit code — callers pass it to
 * `Deno.exit`/`process.exit`.
 */
export async function runSupervised(
  specs: ProcessSpec[],
  options: RunSupervisedOptions = {},
): Promise<number> {
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];

  let resolveShutdown!: (signal: SupervisorSignal) => void;
  const shutdownSignal = new Promise<SupervisorSignal>((resolve) => {
    resolveShutdown = resolve;
  });

  const handlers = signals.map((signal) => {
    const handler = () => resolveShutdown(signal);
    process.on(signal, handler);
    return { signal, handler };
  });

  try {
    return await runProcessGroup(specs, shutdownSignal);
  } finally {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  }
}
