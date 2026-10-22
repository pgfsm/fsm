// Actor: checkBureauRust

/// How many invokes of this actor one worker runs at once. Above 1, the
/// handler runs on several threads at once: shared state needs a `Mutex` or
/// atomics. Delivery is at-least-once, so the handler must also be
/// idempotent: the same invoke can arrive more than once.
pub const MAX_CONCURRENCY: u32 = 5;

#[allow(non_snake_case)]
pub fn checkBureauRust(
    input: serde_json::Value,
    _token: pgfsm_async_worker_sdk::CancellationToken,
) -> serde_json::Value {
    // TODO: implement actor logic
    // _token is cancelled when the gateway cancels this invoke (e.g. its FSM
    // state exited): check _token.is_cancelled() between steps.
    serde_json::json!({ "input": input, "msg": "checkBureauRust actor invoked by rust" })
}
