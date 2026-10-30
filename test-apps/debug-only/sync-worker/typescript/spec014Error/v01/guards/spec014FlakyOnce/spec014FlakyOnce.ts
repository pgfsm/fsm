// Guard: spec014FlakyOnce
// SPEC-014's end-to-end test (#620): throws on its first attempt for each
// message, then passes, so the worker's in-place retry is what lets FLAKY
// through. The worker passes { queueName, msg } as the third argument.
const failedOnce = new Set<string>();

export function spec014FlakyOnce(
  _context: unknown,
  _event: unknown,
  meta?: unknown,
) {
  const { queueName, msg } = (meta ?? {}) as {
    queueName?: string;
    msg?: { msg_id?: number | null };
  };
  const key = `${queueName}:${msg?.msg_id}`;
  if (!failedOnce.has(key)) {
    failedOnce.add(key);
    throw new Error("spec014FlakyOnce: failing the first attempt");
  }
  return true;
}
