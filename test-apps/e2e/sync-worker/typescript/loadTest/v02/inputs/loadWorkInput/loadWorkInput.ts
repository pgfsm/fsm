// Input: loadWorkInput — the input of loadTest v02's four loadWork invokes
// (SPEC-013, #587). The sync worker calls it with the instance's context when
// an invoke starts; the actor receives what it returns. `load.ts instances`
// puts `e2eRunId`, `n` and `workMs` in each instance's context, so actors do
// per-instance work.
export function loadWorkInput(context: any, _event: any): unknown {
  return {
    n: context?.n ?? null,
    runId: context?.e2eRunId ?? null,
    workMs: Number(context?.workMs) || 0,
  };
}
