// Action: saveMapped — SPEC-013's end-to-end test (#587). Keeps what the echo
// actor received (its result is the processed message's event payload) in
// context.mapped.
export function saveMapped(context: any, _params: any, meta: any) {
  return {
    ...(context ?? {}),
    mapped: meta?.msg?.message?.eventData?.eventPayload?.received ?? null,
  };
}
