// Records each acknowledged cancel in the database (SPEC-012 (c), #539): when
// a worker replies to an invoke the gateway cancelled, one
// `cancel_acknowledged` row in fsm_async_operation_queue_event_logs, next to
// the message's other rows, with the reason, outcome and cancel-to-ack
// latency. Wired to SidecarGateway's onCancelAcknowledged by
// startActivityGatewayServer when the poll loop runs.
//
// The write is fire-and-forget: the slot is already free when the hook runs,
// and a failed write is logged, never retried or thrown.

import { getLogger } from "@logtape/logtape";
import { type DBDeps, logAsyncOperationCancelAck } from "@pgfsm/db";
import {
  CANCEL_REASON,
  type CancelAcknowledgement,
  cancelReasonName,
} from "./sidecar/gateway.ts";

const logger = getLogger([
  "@pgfsm/worker",
  "async-op-worker-gateway",
  "cancel-ack-log",
]);

/**
 * Writes `ack`'s row. Skips (resolving false) a `SHUTDOWN` cancel, whose
 * reply can't come back, and an invoke without a queue message (one sent
 * through the gRPC front door rather than the poll loop). Never rejects.
 */
export async function recordCancelAck(
  deps: DBDeps,
  ack: CancelAcknowledgement,
): Promise<boolean> {
  if (ack.reason === CANCEL_REASON.SHUTDOWN || !ack.message) return false;
  try {
    await logAsyncOperationCancelAck(deps, {
      queueName: ack.message.queueName,
      msgId: ack.message.msgId,
      invokeId: ack.invokeId,
      reason: cancelReasonName(ack.reason),
      outcome: ack.outcome,
      cancelToAckMs: ack.cancelToAckMs,
    });
    return true;
  } catch (error) {
    logger.warn(
      "Couldn't record the cancel acknowledgement of invoke {invokeId} (message {msgId} on {queueName}): {error}",
      {
        invokeId: ack.invokeId,
        msgId: String(ack.message.msgId),
        queueName: ack.message.queueName,
        error,
      },
    );
    return false;
  }
}
