// Guard: spec014AlwaysThrows
// SPEC-014's end-to-end test (#620): always throws, so the instance ends in
// status error after maxAttempts.
export function spec014AlwaysThrows(_context: unknown, _event: unknown) {
  throw new Error("spec014AlwaysThrows: always fails");
}
