// Actor: spec012WorkRs — SPEC-012's end-to-end test (#545). Works for up to
// 5s, unless the gateway cancels it: then it stops before its side effect,
// writing the marker file at input["markerPath"].

/// How many invokes of this actor one worker runs at once.
pub const MAX_CONCURRENCY: u32 = 4;

#[allow(non_snake_case)]
pub fn spec012WorkRs(
    input: serde_json::Value,
    token: pgfsm_async_worker_sdk::CancellationToken,
) -> serde_json::Value {
    if token.wait(std::time::Duration::from_secs(5)) {
        // Cancelled: stop here, no side effect.
        panic!("spec012WorkRs cancelled: {:?}", token.reason());
    }
    if let Some(path) = input.get("markerPath").and_then(serde_json::Value::as_str) {
        std::fs::write(path, "rust").expect("write the marker file");
    }
    serde_json::json!({ "done": true, "language": "rust" })
}
