// Actor: spec012WorkTs — SPEC-012's end-to-end test (#545). Works for up to
// 5s, unless the gateway cancels it: then it stops before its side effect,
// writing the marker file at input.markerPath.

export const maxConcurrency = 4;

export async function spec012WorkTs(
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const { markerPath } = (input ?? {}) as { markerPath?: string };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  signal.throwIfAborted(); // cancelled: stop here, no side effect
  if (markerPath) await Deno.writeTextFile(markerPath, "typescript");
  return { done: true, language: "typescript" };
}
