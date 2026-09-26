//! `list`/`start` command handling for a compiler-generated worker `main.rs` —
//! replaces the argument parsing and startup that fsm-compiler-ts's
//! `rust/worker-sdk-main.eta` used to write into every project (#368).
//!
//! Rust counterpart of `@pgfsm/async-worker-sdk`'s `runActorWorkerCli` and
//! `pgfsm-async-worker-sdk`'s `run_actor_worker_cli`. Logging goes through the
//! `log` facade and isn't configured here; the generated `main.rs` sets up a
//! logger once before calling this.

use crate::actor_worker::{
    ActorRegistration, ActorWorker, ActorWorkerOptions, DEFAULT_HEARTBEAT_MS,
};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;

/// Sidecar socket the worker connects to unless `--gateway-socket` is given.
pub const DEFAULT_GATEWAY_SOCKET_PATH: &str = "/tmp/pgfsm-activity-gateway-workers.sock";

const DEFAULT_INVOCATION: &str = "cargo run --release --";

#[derive(Debug, PartialEq)]
enum Command {
    List,
    Start,
}

#[derive(Debug)]
struct ParsedArgs {
    command: Option<Command>,
    gateway_socket_path: String,
    worker_id: Option<String>,
    heartbeat_ms: u64,
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

OPTIONS
  -g, --gateway-socket <path>   Sidecar socket to connect to (default: {DEFAULT_GATEWAY_SOCKET_PATH})
  -i, --worker-id <id>          Stable worker identity (default: rust-<random>)
      --heartbeat-ms <ms>       Heartbeat interval (default: {DEFAULT_HEARTBEAT_MS})
  -h, --help                    Show this help message

Actors come from a compiler-generated registry (see fsm-compiler-ts's
writeAggregateActorsRegistry), linked into the binary at compile time.

EXAMPLE
  {invocation} start --gateway-socket {DEFAULT_GATEWAY_SOCKET_PATH}"
    )
}

fn parse_args(args: Vec<String>) -> Result<ParsedArgs, String> {
    let mut parsed = ParsedArgs {
        command: None,
        gateway_socket_path: DEFAULT_GATEWAY_SOCKET_PATH.to_string(),
        worker_id: None,
        heartbeat_ms: DEFAULT_HEARTBEAT_MS,
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
                parsed.gateway_socket_path = value_for("--gateway-socket")?
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
    Ok(parsed)
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
/// the worker gracefully (unregistering from the gateway) on SIGINT/SIGTERM;
/// those signals stay routed through tokio for the rest of the process.
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

    let worker_id = parsed.worker_id.unwrap_or_else(random_worker_id);

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
            gateway_socket_path: parsed.gateway_socket_path.clone(),
            heartbeat_ms: parsed.heartbeat_ms,
        },
        registrations,
    ));

    runtime.block_on(async {
        let signal_task = tokio::spawn(stop_on_signal(worker.clone()));

        log::info!(
            "Starting worker {}: gateway-socket={}",
            worker_id,
            parsed.gateway_socket_path
        );
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
    })
}

/// `err` followed by each of its `source()`s, joined with `: `. tonic's
/// top-level connection error is just "transport error"; the useful part (for
/// example "No such file or directory") is further down the chain.
fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.ends_with(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
}

async fn stop_on_signal(worker: Arc<ActorWorker>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(err) => {
                log::warn!("Could not install a SIGTERM handler: {}", err);
                let _ = tokio::signal::ctrl_c().await;
                log::info!("Shutdown requested — stopping worker...");
                worker.stop();
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    log::info!("Shutdown requested — stopping worker...");
    worker.stop();
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
        assert_eq!(p.gateway_socket_path, "/tmp/x.sock");
        assert_eq!(p.worker_id.as_deref(), Some("w1"));
        assert_eq!(p.heartbeat_ms, 250);
    }

    #[test]
    fn defaults() {
        let p = parse(&["list"]).unwrap();
        assert_eq!(p.command, Some(Command::List));
        assert_eq!(p.gateway_socket_path, DEFAULT_GATEWAY_SOCKET_PATH);
        assert_eq!(p.heartbeat_ms, DEFAULT_HEARTBEAT_MS);
        assert!(p.worker_id.is_none());
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
    fn random_worker_id_has_prefix() {
        let id = random_worker_id();
        assert!(id.starts_with("rust-") && id.len() == 13, "{}", id);
    }
}
