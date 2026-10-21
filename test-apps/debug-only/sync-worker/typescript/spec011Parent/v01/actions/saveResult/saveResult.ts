// Action: saveResult — SPEC-011's end-to-end test (#536). Keeps the
// spec011RetryWork result that finished the Retrying state, so the test can
// tell which invoke drove the parent: the actor's output is the processed
// message's event payload.
export function saveResult(context: any, _params: any, meta: any) {
  return {
    ...(context ?? {}),
    result: meta?.msg?.message?.eventData?.eventPayload ?? null,
  };
}
