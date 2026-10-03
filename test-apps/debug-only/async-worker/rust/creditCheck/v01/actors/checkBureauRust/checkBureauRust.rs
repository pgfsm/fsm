// Actor: checkBureauRust

/// How many invokes of this actor one worker runs at once. Above 1, the
/// handler runs on several threads at once: shared state needs a `Mutex` or
/// atomics. Delivery is at-least-once, so the handler must also be
/// idempotent: the same invoke can arrive more than once.
pub const MAX_CONCURRENCY: u32 = 5;

#[allow(non_snake_case)]
pub fn checkBureauRust(input: serde_json::Value) -> serde_json::Value {
    // TODO: implement actor logic
    serde_json::json!({ "input": input, "msg": "checkBureauRust actor invoked by rust" })
}
