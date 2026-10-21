//! The cancellation token every handler gets (SPEC-012).
//!
//! Handlers are sync and run on tokio's blocking pool, so the token supports
//! both styles: poll [`CancellationToken::is_cancelled`] between steps, block
//! on [`CancellationToken::wait`] for up to a timeout, or, from a handler that
//! bridges to async code, await [`CancellationToken::cancelled`].

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

/// Why the gateway cancelled an invoke: the generated
/// `pgfsm.sidecargateway.v1.CancelReason`.
pub use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::CancelReason;

/// Cancelled when the gateway cancels this invoke, or when the worker's
/// session with the gateway ends ([`CancelReason::Shutdown`]). Cheap to clone;
/// every clone sees the same cancellation.
#[derive(Clone, Default)]
pub struct CancellationToken {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    reason: Mutex<Option<CancelReason>>,
    changed: Condvar,
    notify: Notify,
}

impl CancellationToken {
    /// A token that isn't cancelled.
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the invoke was cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.reason().is_some()
    }

    /// Why the invoke was cancelled, or `None` if it wasn't.
    pub fn reason(&self) -> Option<CancelReason> {
        *self.inner.reason.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Blocks until the invoke is cancelled or `timeout` passes; returns
    /// whether it was cancelled. For sync handlers, e.g. instead of a sleep.
    pub fn wait(&self, timeout: Duration) -> bool {
        let guard = self.inner.reason.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = self
            .inner
            .changed
            .wait_timeout_while(guard, timeout, |reason| reason.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.is_some()
    }

    /// Resolves once the invoke is cancelled.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            // Registered before the check, so a cancel in between still
            // wakes it.
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// Cancels with `reason`. The first reason wins; later calls are no-ops.
    pub(crate) fn cancel(&self, reason: CancelReason) {
        {
            let mut current = self.inner.reason.lock().unwrap_or_else(|e| e.into_inner());
            if current.is_some() {
                return;
            }
            *current = Some(reason);
        }
        self.inner.changed.notify_all();
        self.inner.notify.notify_waiters();
    }
}

impl std::fmt::Debug for CancellationToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CancellationToken")
            .field("reason", &self.reason())
            .finish()
    }
}
