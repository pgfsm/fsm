//! `list`/`start` command handling for a compiler-generated worker `main.rs` —
//! replaces the argument parsing and startup that fsm-compiler-ts's
//! `rust/worker-sdk-main.eta` used to write into every project (#368).
//!
//! Rust counterpart of `@pgfsm/async-worker-sdk`'s `runActorWorkerCli` and
//! `pgfsm-async-worker-sdk`'s `run_actor_worker_cli`. Logging goes through the
//! `log` facade and isn't configured here; the generated `main.rs` sets up a
//! logger once before calling this.

use crate::actor_worker::{
    error_chain, parse_gateway_address, ActorRegistration, ActorWorker, ActorWorkerOptions,
    DEFAULT_HEARTBEAT_MS, DEFAULT_KEEPALIVE_INTERVAL_MS, DEFAULT_KEEPALIVE_TIMEOUT_MS,
    DEFAULT_RECONNECT_INITIAL_DELAY_MS, DEFAULT_RECONNECT_MAX_DELAY_MS, DEFAULT_SHUTDOWN_GRACE_MS,
};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::path::PathBuf;
use std::sync::Arc;

/// Sidecar socket the worker connects to unless `--gateway-socket` is given.
pub const DEFAULT_GATEWAY_SOCKET_PATH: &str = "/tmp/pgfsm-activity-gateway-workers.sock";

const DEFAULT_INVOCATION: &str = "cargo run --release --";

#[derive(Debug, PartialEq, Clone, Copy)]
enum Command {
    List,
    Start,
}

#[derive(Debug)]
struct ParsedArgs {
    command: Option<Command>,
    gateway_socket_path: Option<String>,
    gateway_address: Option<String>,
    ca_file: Option<PathBuf>,
    token_file: Option<PathBuf>,
    cert_file: Option<PathBuf>,
    key_file: Option<PathBuf>,
    max_concurrency: u32,
    keepalive_interval_ms: u64,
    keepalive_timeout_ms: u64,
    shutdown_grace_ms: u64,
    worker_id: Option<String>,
    heartbeat_ms: u64,
    reconnect_initial_delay_ms: u64,
    reconnect_max_delay_ms: u64,
    reconnect_max_attempts: u32,
    help: bool,
}

fn help_text(invocation: &str) -> String {
    format!(
        "pgfsm-async-worker-sdk — Rust worker for the Activity Gateway

USAGE
  {invocation} <list|start> [options]

COMMANDS
  list    Print the actors compiled into this registry, without connecting to the gateway.
  start   Connect to the gateway and serve invocations for every actor in the registry until stopped.
          Waits for the gateway if it isn't up yet, and reconnects and re-registers if the
          session drops (e.g. the gateway restarts). On SIGINT/SIGTERM it drains: new invokes
          are refused as retriable while in-flight ones finish.

OPTIONS
  -g, --gateway-socket <path>   Sidecar socket to connect to (default: {DEFAULT_GATEWAY_SOCKET_PATH})
  -a, --gateway-address <addr>  Gateway sidecar address instead: unix:<path>, https://host:port,
                                or http://host:port (the gateway's --insecure-plaintext test mode)
      --gateway-ca-file <file>  PEM CA bundle to trust the gateway's TLS certificate (default: system roots)
      --gateway-token-file <file>
                                Bearer token sent to the gateway; re-read on every reconnect
      --gateway-cert-file <file>
      --gateway-key-file <file> Client certificate and key for mutual TLS
  -c, --max-concurrency <n>     Invokes of each actor run at once, for actors without their own
                                max_concurrency (default: 1). Handlers must be concurrency-safe above 1.
      --keepalive-interval-ms <ms>
                                HTTP/2 PING interval over TCP (default: {DEFAULT_KEEPALIVE_INTERVAL_MS}; 0 disables)
      --keepalive-timeout-ms <ms>
                                Reconnect when a PING goes unanswered this long (default: {DEFAULT_KEEPALIVE_TIMEOUT_MS})
      --shutdown-grace-ms <ms>  On SIGINT/SIGTERM, let in-flight invokes finish this long (default: {DEFAULT_SHUTDOWN_GRACE_MS})
  -i, --worker-id <id>          Stable worker identity (default: rust-<random>)
      --heartbeat-ms <ms>       Heartbeat interval (default: {DEFAULT_HEARTBEAT_MS})
      --reconnect-initial-delay-ms <ms>
                                First reconnect backoff step (default: {DEFAULT_RECONNECT_INITIAL_DELAY_MS})
      --reconnect-max-delay-ms <ms>
                                Reconnect backoff cap (default: {DEFAULT_RECONNECT_MAX_DELAY_MS})
      --reconnect-max-attempts <n>
                                Exit after n consecutive failed attempts (default: 0 = retry forever)
  -h, --help                    Show this help message

Actors come from a compiler-generated registry (see fsm-compiler-ts's
writeAggregateActorsRegistry), linked into the binary at compile time.

EXAMPLES
  {invocation} start --gateway-socket {DEFAULT_GATEWAY_SOCKET_PATH}
  {invocation} start --gateway-address https://activity-gateway:7443 \\
    --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10"
    )
}

fn parse_args(args: Vec<String>) -> Result<ParsedArgs, String> {
    let mut parsed = ParsedArgs {
        command: None,
        gateway_socket_path: None,
        gateway_address: None,
        ca_file: None,
        token_file: None,
        cert_file: None,
        key_file: None,
        max_concurrency: 0,
        keepalive_interval_ms: DEFAULT_KEEPALIVE_INTERVAL_MS,
        keepalive_timeout_ms: DEFAULT_KEEPALIVE_TIMEOUT_MS,
        shutdown_grace_ms: DEFAULT_SHUTDOWN_GRACE_MS,
        worker_id: None,
        heartbeat_ms: DEFAULT_HEARTBEAT_MS,
        reconnect_initial_delay_ms: DEFAULT_RECONNECT_INITIAL_DELAY_MS,
        reconnect_max_delay_ms: DEFAULT_RECONNECT_MAX_DELAY_MS,
        reconnect_max_attempts: 0,
        help: false,
    };

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        // Accept both `--flag value` and `--flag=value`.
        let (flag, inline_value) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value_for = |name: &str| -> Result<String, String> {
            match inline_value.clone() {
                Some(v) => Ok(v),
                None => iter
                    .next()
                    .ok_or_else(|| format!("{} requires a value", name)),
            }
        };
        match flag.as_str() {
            "-h" | "--help" => parsed.help = true,
            "-g" | "--gateway-socket" => {
                parsed.gateway_socket_path = Some(value_for("--gateway-socket")?)
            }
            "-a" | "--gateway-address" => {
                let value = value_for("--gateway-address")?;
                parse_gateway_address(&value)?;
                parsed.gateway_address = Some(value);
            }
            "--gateway-ca-file" => parsed.ca_file = Some(value_for("--gateway-ca-file")?.into()),
            "--gateway-token-file" => {
                parsed.token_file = Some(value_for("--gateway-token-file")?.into())
            }
            "--gateway-cert-file" => {
                parsed.cert_file = Some(value_for("--gateway-cert-file")?.into())
            }
            "--gateway-key-file" => parsed.key_file = Some(value_for("--gateway-key-file")?.into()),
            "-c" | "--max-concurrency" => {
                let value = value_for("--max-concurrency")?;
                parsed.max_concurrency = parse_positive(&value, "--max-concurrency")?
                    .try_into()
                    .map_err(|_| format!("--max-concurrency is too large: {}", value))?;
            }
            "--keepalive-interval-ms" => {
                let value = value_for("--keepalive-interval-ms")?;
                parsed.keepalive_interval_ms = value.parse::<u64>().map_err(|_| {
                    format!(
                        "--keepalive-interval-ms must be a non-negative integer, got: {}",
                        value
                    )
                })?;
            }
            "--keepalive-timeout-ms" => {
                let value = value_for("--keepalive-timeout-ms")?;
                parsed.keepalive_timeout_ms = parse_positive(&value, "--keepalive-timeout-ms")?;
            }
            "--shutdown-grace-ms" => {
                let value = value_for("--shutdown-grace-ms")?;
                parsed.shutdown_grace_ms = value.parse::<u64>().map_err(|_| {
                    format!(
                        "--shutdown-grace-ms must be a non-negative integer, got: {}",
                        value
                    )
                })?;
            }
            "-i" | "--worker-id" => parsed.worker_id = Some(value_for("--worker-id")?),
            "--heartbeat-ms" => {
                let value = value_for("--heartbeat-ms")?;
                parsed.heartbeat_ms = match value.parse::<u64>() {
                    Ok(ms) if ms > 0 => ms,
                    _ => {
                        return Err(format!(
                            "--heartbeat-ms must be a positive integer, got: {}",
                            value
                        ))
                    }
                };
            }
            "--reconnect-initial-delay-ms" => {
                let value = value_for("--reconnect-initial-delay-ms")?;
                parsed.reconnect_initial_delay_ms =
                    parse_positive(&value, "--reconnect-initial-delay-ms")?;
            }
            "--reconnect-max-delay-ms" => {
                let value = value_for("--reconnect-max-delay-ms")?;
                parsed.reconnect_max_delay_ms = parse_positive(&value, "--reconnect-max-delay-ms")?;
            }
            "--reconnect-max-attempts" => {
                let value = value_for("--reconnect-max-attempts")?;
                parsed.reconnect_max_attempts = value.parse::<u32>().map_err(|_| {
                    format!(
                        "--reconnect-max-attempts must be a non-negative integer, got: {}",
                        value
                    )
                })?;
            }
            "list" | "start" if parsed.command.is_none() => {
                parsed.command = Some(if flag == "list" {
                    Command::List
                } else {
                    Command::Start
                });
            }
            other if other.starts_with('-') => return Err(format!("unknown option: {}", other)),
            other => {
                return Err(format!(
                    "First argument must be one of: list, start. Got: {}",
                    other
                ))
            }
        }
    }
    if parsed.gateway_socket_path.is_some() && parsed.gateway_address.is_some() {
        return Err("Pass either --gateway-socket or --gateway-address, not both".to_string());
    }
    if parsed.cert_file.is_some() != parsed.key_file.is_some() {
        return Err("--gateway-cert-file and --gateway-key-file go together".to_string());
    }
    Ok(parsed)
}

/// Fails fast on unreadable credentials instead of retrying forever.
fn check_readable(parsed: &ParsedArgs) -> Result<(), String> {
    for (flag, path) in [
        ("--gateway-ca-file", &parsed.ca_file),
        ("--gateway-token-file", &parsed.token_file),
        ("--gateway-cert-file", &parsed.cert_file),
        ("--gateway-key-file", &parsed.key_file),
    ] {
        if let Some(path) = path {
            if std::fs::File::open(path).is_err() {
                return Err(format!("Can't read {} file {}", flag, path.display()));
            }
        }
    }
    Ok(())
}

fn parse_positive(value: &str, flag: &str) -> Result<u64, String> {
    match value.parse::<u64>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(format!(
            "{} must be a positive integer, got: {}",
            flag, value
        )),
    }
}

fn random_worker_id() -> String {
    // RandomState is seeded per process from the OS, so this is a cheap random
    // suffix without pulling in a rand dependency.
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(std::process::id());
    format!("rust-{:08x}", hasher.finish() as u32)
}

/// Runs the `list`/`start` worker CLI against `registrations` and returns the
/// process exit code — the caller decides whether to exit with it, which keeps
/// this testable. `args` excludes the program name (`std::env::args().skip(1)`).
///
/// `start` builds its own multi-threaded tokio runtime, so call this from a
/// plain (non-async) `main`, not from inside another tokio runtime. It stops
/// the worker gracefully on SIGINT/SIGTERM (draining in-flight invokes, then
/// unregistering from the gateway); those signals stay routed through tokio
/// for the rest of the process.
///
/// `invocation` is how to run the calling binary, shown in `--help`; defaults
/// to `cargo run --release --`.
pub fn run_actor_worker_cli<I, S>(
    registrations: Vec<ActorRegistration>,
    args: I,
    invocation: Option<&str>,
) -> i32
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let invocation = invocation.unwrap_or(DEFAULT_INVOCATION);
    let parsed = match parse_args(args.into_iter().map(Into::into).collect()) {
        Ok(p) => p,
        Err(message) => {
            log::error!("{}", message);
            println!("{}", help_text(invocation));
            return 1;
        }
    };

    if parsed.help {
        println!("{}", help_text(invocation));
        return 0;
    }

    let command = match parsed.command {
        Some(c) => c,
        None => {
            log::error!("First argument must be one of: list, start. Got: (none)");
            println!("{}", help_text(invocation));
            return 1;
        }
    };

    if let Err(message) = check_readable(&parsed) {
        log::error!("{}", message);
        return 1;
    }
    let gateway_address = parsed.gateway_address.clone().unwrap_or_else(|| {
        format!(
            "unix:{}",
            parsed
                .gateway_socket_path
                .as_deref()
                .unwrap_or(DEFAULT_GATEWAY_SOCKET_PATH)
        )
    });
    let worker_id = parsed.worker_id.clone().unwrap_or_else(random_worker_id);

    log::info!(
        "{} actor(s) compiled into this registry",
        registrations.len()
    );
    for reg in &registrations {
        log::info!(
            "  + {}@{} (parent {}@{})",
            reg.meta.async_operation_name,
            reg.meta.async_operation_version,
            reg.meta.parent_fsm_name,
            reg.meta.parent_fsm_version
        );
    }

    if command == Command::List {
        return 0;
    }

    if registrations.is_empty() {
        log::error!("No actors in the registry, refusing to start worker");
        return 1;
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            log::error!("Failed to start the async runtime: {}", err);
            return 1;
        }
    };

    let worker = Arc::new(ActorWorker::new(
        ActorWorkerOptions {
            worker_id: worker_id.clone(),
            gateway_address: Some(gateway_address.clone()),
            ca_file: parsed.ca_file.clone(),
            token_file: parsed.token_file.clone(),
            cert_file: parsed.cert_file.clone(),
            key_file: parsed.key_file.clone(),
            keepalive_interval_ms: parsed.keepalive_interval_ms,
            keepalive_timeout_ms: parsed.keepalive_timeout_ms,
            max_concurrency: parsed.max_concurrency,
            shutdown_grace_ms: parsed.shutdown_grace_ms,
            heartbeat_ms: parsed.heartbeat_ms,
            reconnect_initial_delay_ms: parsed.reconnect_initial_delay_ms,
            reconnect_max_delay_ms: parsed.reconnect_max_delay_ms,
            reconnect_max_attempts: parsed.reconnect_max_attempts,
            ..Default::default()
        },
        registrations,
    ));

    let code = runtime.block_on(async {
        let signal_task = tokio::spawn(stop_on_signal(worker.clone()));

        log::info!("Starting worker {}: gateway={}", worker_id, gateway_address);
        let result = worker.run().await;
        signal_task.abort();

        match result {
            Ok(()) => {
                log::info!("Worker {} stopped.", worker_id);
                0
            }
            Err(err) => {
                log::error!("Worker {} failed: {}", worker_id, error_chain(err.as_ref()));
                1
            }
        }
    });
    // A handler still running past the drain's grace period (Rust can't kill
    // its thread) mustn't hold up the exit: dropping the runtime would wait
    // for that blocking thread to return.
    runtime.shutdown_background();
    code
}

async fn stop_on_signal(worker: Arc<ActorWorker>) {
    #[cfg(unix)]
    let mut sigterm = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        Ok(s) => Some(s),
        Err(err) => {
            log::warn!("Could not install a SIGTERM handler: {}", err);
            None
        }
    };
    let mut stop_requested = false;
    loop {
        #[cfg(unix)]
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                match sigterm.as_mut() {
                    Some(s) => { s.recv().await; }
                    None => std::future::pending::<()>().await,
                }
            } => {}
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;

        if stop_requested {
            log::info!("Already stopping: waiting for in-flight invokes to finish");
            continue;
        }
        stop_requested = true;
        log::info!("Shutdown requested — draining and stopping worker...");
        worker.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<ParsedArgs, String> {
        parse_args(args.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn parses_command_and_options() {
        let p = parse(&[
            "start",
            "-g",
            "/tmp/x.sock",
            "--worker-id=w1",
            "--heartbeat-ms",
            "250",
        ])
        .unwrap();
        assert_eq!(p.command, Some(Command::Start));
        assert_eq!(p.gateway_socket_path.as_deref(), Some("/tmp/x.sock"));
        assert_eq!(p.worker_id.as_deref(), Some("w1"));
        assert_eq!(p.heartbeat_ms, 250);
    }

    #[test]
    fn defaults() {
        let p = parse(&["list"]).unwrap();
        assert_eq!(p.command, Some(Command::List));
        assert!(p.gateway_socket_path.is_none() && p.gateway_address.is_none());
        assert_eq!(p.max_concurrency, 0);
        assert_eq!(p.keepalive_interval_ms, DEFAULT_KEEPALIVE_INTERVAL_MS);
        assert_eq!(p.keepalive_timeout_ms, DEFAULT_KEEPALIVE_TIMEOUT_MS);
        assert_eq!(p.shutdown_grace_ms, DEFAULT_SHUTDOWN_GRACE_MS);
        assert_eq!(p.heartbeat_ms, DEFAULT_HEARTBEAT_MS);
        assert!(p.worker_id.is_none());
        assert_eq!(
            p.reconnect_initial_delay_ms,
            DEFAULT_RECONNECT_INITIAL_DELAY_MS
        );
        assert_eq!(p.reconnect_max_delay_ms, DEFAULT_RECONNECT_MAX_DELAY_MS);
        assert_eq!(p.reconnect_max_attempts, 0);
    }

    #[test]
    fn parses_reconnect_options() {
        let p = parse(&[
            "start",
            "--reconnect-initial-delay-ms=5",
            "--reconnect-max-delay-ms",
            "100",
            "--reconnect-max-attempts",
            "3",
        ])
        .unwrap();
        assert_eq!(p.reconnect_initial_delay_ms, 5);
        assert_eq!(p.reconnect_max_delay_ms, 100);
        assert_eq!(p.reconnect_max_attempts, 3);
        assert!(parse(&["start", "--reconnect-initial-delay-ms", "0"]).is_err());
        assert!(parse(&["start", "--reconnect-max-attempts", "-1"]).is_err());
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse(&["serve"]).is_err());
        assert!(parse(&["start", "--gateway-socket"]).is_err());
        assert!(parse(&["start", "--heartbeat-ms", "0"]).is_err());
        assert!(parse(&["start", "--bogus"]).is_err());
        assert!(parse(&["list", "start"]).is_err());
    }

    #[test]
    fn parses_tcp_concurrency_and_drain_options() {
        let p = parse(&[
            "start",
            "-a",
            "https://gw:7443",
            "--gateway-ca-file=ca.crt",
            "--gateway-token-file",
            "token",
            "--gateway-cert-file",
            "c.crt",
            "--gateway-key-file",
            "c.key",
            "-c",
            "10",
            "--keepalive-interval-ms",
            "0",
            "--keepalive-timeout-ms",
            "500",
            "--shutdown-grace-ms",
            "0",
        ])
        .unwrap();
        assert_eq!(p.gateway_address.as_deref(), Some("https://gw:7443"));
        assert_eq!(p.ca_file, Some(PathBuf::from("ca.crt")));
        assert_eq!(p.token_file, Some(PathBuf::from("token")));
        assert_eq!(p.cert_file, Some(PathBuf::from("c.crt")));
        assert_eq!(p.key_file, Some(PathBuf::from("c.key")));
        assert_eq!(p.max_concurrency, 10);
        assert_eq!(p.keepalive_interval_ms, 0);
        assert_eq!(p.keepalive_timeout_ms, 500);
        assert_eq!(p.shutdown_grace_ms, 0);
    }

    #[test]
    fn rejects_bad_tcp_concurrency_and_drain_options() {
        for args in [
            &["start", "-g", "/tmp/x.sock", "-a", "unix:/tmp/y.sock"][..],
            &["start", "-a", "tcp://gw:1"],
            &["start", "-a", "https://gw"],
            &["start", "-a", "unix:"],
            &["start", "--gateway-cert-file", "c.crt"],
            &["start", "--gateway-key-file", "c.key"],
            &["start", "-c", "0"],
            &["start", "-c", "-1"],
            &["start", "-c", ""],
            &["start", "-c", "99999999999"],
            &["start", "--keepalive-interval-ms", "-1"],
            &["start", "--keepalive-timeout-ms", "0"],
            &["start", "--shutdown-grace-ms", ""],
        ] {
            assert!(parse(args).is_err(), "{:?}", args);
        }
    }

    #[test]
    fn random_worker_id_has_prefix() {
        let id = random_worker_id();
        assert!(id.starts_with("rust-") && id.len() == 13, "{}", id);
    }
}
