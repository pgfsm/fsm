// Action: spec014AlwaysThrowsAction
// SPEC-014's end-to-end test (#620): always throws, so the child instance ends
// in status error and its parent's onError is taken.
export function spec014AlwaysThrowsAction(_context: unknown, _event: unknown) {
  throw new Error("spec014AlwaysThrowsAction: always fails");
}
