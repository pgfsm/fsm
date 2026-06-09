import type { Pool } from "pg";

// Sets up a single shared LISTEN connection for the app's lifetime.
// The client is intentionally never released — dedicated to receiving stop signals.
export async function pgListenerForWorkerStopEvent(
  pool: Pool,
  onStop: (queueName: string) => void,
): Promise<void> {
  const listenClient = await pool.connect();
  await listenClient.query("LISTEN fsm_worker_stop");
  listenClient.on("notification", (msg) => {
    if (msg.payload) {
      onStop(msg.payload);
    }
  });
}
