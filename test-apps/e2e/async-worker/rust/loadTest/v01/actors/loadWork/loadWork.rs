// Actor: loadWork — the SPEC-007 acceptance suite's load (#458). Sleeps for
// `workMs`, then reports which worker processed the message, so the suite can
// tell replicas apart (`worker` is the pod name in Kubernetes).

/// How many invokes of this actor one worker runs at once. Above 1, the
/// handler runs on several threads at once: shared state needs a `Mutex` or
/// atomics. Delivery is at-least-once, so the handler must also be
/// idempotent: the same invoke can arrive more than once.
pub const MAX_CONCURRENCY: u32 = 1;

const MAX_WORK_MS: u64 = 600_000;

#[allow(non_snake_case)]
pub fn loadWork(input: serde_json::Value) -> serde_json::Value {
    let work_ms = input
        .get("workMs")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, MAX_WORK_MS as f64) as u64;
    std::thread::sleep(std::time::Duration::from_millis(work_ms));
    // The pod name in Kubernetes (HOSTNAME, or /etc/hostname on Linux).
    let worker = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    serde_json::json!({
        "n": input.get("n"),
        "runId": input.get("runId"),
        "worker": worker,
        "language": "rust",
    })
}
