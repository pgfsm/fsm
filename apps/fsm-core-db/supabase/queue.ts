import type { Database } from "../database.types.ts";
import type { DBDeps } from "./custom-type.ts";

export async function tryFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  const lockedBy = "some-identifier"; // Replace with actual identifier
  const { data, error } = await deps.supabase.rpc("lock_fsm_instance", {
    p_fsm_instance_id: fsmInstanceId,
    p_locked_by: lockedBy,
  });
  if (error) throw error;
  return data === true;
}

export async function releaseFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string,
): Promise<boolean> {
  const { data, error } = await deps.supabase.rpc("unlock_fsm_instance", {
    p_fsm_instance_id: fsmInstanceId,
  });
  if (error) throw error;
  return data === true;
}

export async function readMessage(
  deps: DBDeps,
  queueName: string,
  vt: number,
): Promise<Database["pgmq"]["CompositeTypes"]["message_record"][]> {
  const { data, error } = await deps.supabase.rpc("read", {
    queue_name: queueName,
    vt,
    qty: 1,
  });
  if (error) throw error;
  return data;
}

export async function deleteMessage(
  deps: DBDeps,
  queueName: string,
  msgId: number,
): Promise<void> {
  const { error } = await deps.supabase.rpc("delete", {
    queue_name: queueName,
    message_id: msgId,
  });
  if (error) throw error;
}

export async function archiveMessage(
  deps: DBDeps,
  queueName: string,
  msgId: number,
): Promise<void> {
  const { error } = await deps.supabase.rpc("archive", {
    queue_name: queueName,
    message_id: msgId,
  });
  if (error) throw error;
}

export async function isFSMQueuePresent(
  deps: DBDeps,
  queue: string,
): Promise<boolean> {
  const { data, error } = await deps.supabase
    .from("fsm_instance")
    .select("id, fsm_name, fsm_version")
    .eq("id", queue)
    .limit(1);
  if (error) {
    console.error("Error checking queue existence (supabase):", error);
    return false;
  }
  // Return false if data is empty array or falsy
  return Array.isArray(data) ? data[0] : !!data;
}

/**
 * Checks whether a PGMQ queue with the given name exists in the database.
 * Uses the `public.list_queues()` wrapper when available.
 * @param deps - DBDeps containing either supabase or drizzle client
 * @param queueName - The PGMQ queue name to check
 * @returns Promise<boolean>
 */
export async function pgmqQueueExists(
  deps: DBDeps,
  queueName: string,
): Promise<boolean> {
  if (!queueName) return false;
  try {
    const { data, error } = await deps.supabase.rpc("list_queues");
    if (error) {
      console.error("Error calling list_queues RPC (supabase):", error);
      return false;
    }
    if (!Array.isArray(data)) return false;
    return data.some((q: any) =>
      q?.name === queueName || q?.queue_name === queueName
    );
  } catch (err) {
    console.error("Unexpected error checking pgmq queues (supabase):", err);
    return false;
  }
}
