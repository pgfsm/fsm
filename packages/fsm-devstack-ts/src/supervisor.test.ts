import { assertEquals } from "@std/assert";
import { type ProcessSpec, runProcessGroup } from "./supervisor.ts";

// Cross-platform test doubles: spawn `deno eval` rather than a shell command
// so these tests don't assume bash/sh is present.
function quickExit(code: number): ProcessSpec {
  return {
    name: `quick-exit-${code}`,
    cmd: Deno.execPath(),
    args: ["eval", `Deno.exit(${code})`],
  };
}

function longRunning(name: string): ProcessSpec {
  return {
    name,
    cmd: Deno.execPath(),
    // A dangling `await new Promise(() => {})` has no pending op keeping the
    // event loop alive, so Deno detects the never-resolving top-level await
    // and exits (non-zero) almost immediately instead of hanging — a repeating
    // timer is a genuine pending op, so this actually stays up until killed.
    args: ["eval", "setInterval(() => {}, 60_000)"],
  };
}

function neverSignals(): Promise<Deno.Signal> {
  return new Promise(() => {});
}

Deno.test("runProcessGroup tears down remaining processes when one exits early (non-zero)", async () => {
  const code = await runProcessGroup(
    [quickExit(3), longRunning("sidecar")],
    neverSignals(),
  );
  assertEquals(code, 3);
});

Deno.test("runProcessGroup treats an unexpected clean exit (code 0) as a failure", async () => {
  const code = await runProcessGroup(
    [quickExit(0), longRunning("sidecar")],
    neverSignals(),
  );
  assertEquals(code, 1);
});

Deno.test("runProcessGroup returns 0 and stops all children on requested shutdown", async () => {
  let resolveShutdown!: (signal: Deno.Signal) => void;
  const shutdownSignal = new Promise<Deno.Signal>((resolve) => {
    resolveShutdown = resolve;
  });

  const run = runProcessGroup(
    [longRunning("a"), longRunning("b")],
    shutdownSignal,
  );
  resolveShutdown("SIGINT");

  const code = await run;
  assertEquals(code, 0);
});

Deno.test("runProcessGroup rejects an empty process list", async () => {
  try {
    await runProcessGroup([], neverSignals());
    throw new Error("expected runProcessGroup to throw");
  } catch (err) {
    assertEquals(
      (err as Error).message,
      "runProcessGroup requires at least one process",
    );
  }
});
