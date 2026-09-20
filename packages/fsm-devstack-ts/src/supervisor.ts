export interface ProcessSpec {
  /** Human-readable name used in log/error output — not the argv[0]. */
  name: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RunningProcess {
  spec: ProcessSpec;
  child: Deno.ChildProcess;
}

type RaceResult =
  | { kind: "signal"; signal: Deno.Signal }
  | { kind: "exit"; spec: ProcessSpec; status: Deno.CommandStatus };

function killAll(children: RunningProcess[], signal: Deno.Signal): void {
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
  shutdownSignal: Promise<Deno.Signal>,
): Promise<number> {
  if (specs.length === 0) {
    throw new Error("runProcessGroup requires at least one process");
  }

  const children: RunningProcess[] = specs.map((spec) => ({
    spec,
    child: new Deno.Command(spec.cmd, {
      args: spec.args ?? [],
      env: spec.env,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "null",
    }).spawn(),
  }));

  const exited = Promise.race(
    children.map(({ spec, child }) =>
      child.status.then((status): RaceResult => ({
        kind: "exit",
        spec,
        status,
      }))
    ),
  );
  const signaled = shutdownSignal.then((signal): RaceResult => ({
    kind: "signal",
    signal,
  }));

  const winner = await Promise.race([exited, signaled]);

  if (winner.kind === "signal") {
    killAll(children, winner.signal);
    await Promise.allSettled(children.map((c) => c.child.status));
    return 0;
  }

  // A child exited on its own before shutdown was requested — fail fast and
  // tear down the rest, rather than leaving a silently half-dead stack up.
  console.error(
    `[devstack] "${winner.spec.name}" exited unexpectedly (code ${winner.status.code}); shutting down remaining processes`,
  );
  killAll(children, "SIGTERM");
  await Promise.allSettled(children.map((c) => c.child.status));
  return winner.status.code === 0 ? 1 : winner.status.code;
}

export interface RunSupervisedOptions {
  /** OS signals that trigger a graceful shutdown. Defaults to SIGINT/SIGTERM. */
  signals?: Deno.Signal[];
}

/**
 * Spawns every process in `specs`, forwards SIGINT/SIGTERM to all of them on
 * shutdown, and fails fast (tearing down the rest) if any child exits on its
 * own first. Resolves with the process's exit code — callers pass it to
 * `Deno.exit`.
 */
export async function runSupervised(
  specs: ProcessSpec[],
  options: RunSupervisedOptions = {},
): Promise<number> {
  const signals = options.signals ?? ["SIGINT", "SIGTERM"];

  let resolveShutdown!: (signal: Deno.Signal) => void;
  const shutdownSignal = new Promise<Deno.Signal>((resolve) => {
    resolveShutdown = resolve;
  });

  const handlers = signals.map((signal) => {
    const handler = () => resolveShutdown(signal);
    Deno.addSignalListener(signal, handler);
    return { signal, handler };
  });

  try {
    return await runProcessGroup(specs, shutdownSignal);
  } finally {
    for (const { signal, handler } of handlers) {
      Deno.removeSignalListener(signal, handler);
    }
  }
}
