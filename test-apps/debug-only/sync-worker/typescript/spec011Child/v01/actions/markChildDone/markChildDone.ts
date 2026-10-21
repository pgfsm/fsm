// Action: markChildDone — SPEC-011's end-to-end test (#536). Runs only if the
// child's actor finishes, which the test never lets happen: the parent stops
// the child first.
export function markChildDone(context: any, _params: any) {
  return { ...(context ?? {}), childDone: true };
}
