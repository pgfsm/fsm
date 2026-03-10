import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types.ts';



export interface DBDeps {
  useSupabase: boolean;
  supabase: SupabaseClient;
  db: any; // Replace with actual DB client type, e.g., PGClient
  // If using drizzle, you might want to specify the type accordingly
}


export async function tryFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string
): Promise<boolean> {
  const lockedBy = 'some-identifier'; // Replace with actual identifier
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc('lock_fsm_instance', {
      p_fsm_instance_id: fsmInstanceId,
      p_locked_by: lockedBy
    });
    if (error) throw error;
    return data === true;
  } else {
    // For direct SQL, call the function and return the boolean result
    const res = await deps.db.execute(
      `SELECT lock_fsm_instance('${fsmInstanceId}', '${lockedBy}') AS locked;`
    );
    return res.rows[0]?.locked === true;
  }
}



export async function releaseFSMDBLock(
  deps: DBDeps,
  fsmInstanceId: string
): Promise<boolean> {
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc('unlock_fsm_instance', {
      p_fsm_instance_id: fsmInstanceId
    });
    if (error) throw error;
    return data === true;
  } else {
    // For direct SQL, call the function and return the boolean result
    const res = await deps.db.execute(
      `SELECT unlock_fsm_instance('${fsmInstanceId}') AS unlocked;`
    );
    return res.rows[0]?.unlocked === true;
  }
}

export async function readMessage(deps: DBDeps, queueName: string, vt: number): Promise<Database["pgmq"]["CompositeTypes"]["message_record"][]> {
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase.rpc('read', {
      queue_name: queueName,
      vt,
      qty: 1,
    });
    if (error) throw error;
    return data 
  } else {
    const res = await deps.db.execute(`SELECT * FROM pgmq.read('${queueName}', ${vt});`);
    return res.rows 
  }
}

export async function deleteMessage(deps: DBDeps, queueName: string, msgId: number): Promise<void> {
  if (deps.useSupabase) {
    const { error } = await deps.supabase.rpc('delete', {
      queue_name: queueName,
      message_id: msgId
    });
    if (error) throw error;
  } else {
    await deps.db.execute(`SELECT * FROM pgmq.delete('${queueName}', ${msgId});`);
  }
}

export async function archiveMessage(deps: DBDeps, queueName: string, msgId: number): Promise<void> {
  if (deps.useSupabase) {
    const { error } = await deps.supabase.rpc('archive', {
      queue_name: queueName,
      message_id: msgId
    });
    if (error) throw error;
  } else {
    await deps.db.execute(`SELECT * FROM pgmq.archive('${queueName}', ${msgId});`);
  }
}


export async function isFSMQueuePresent(deps: DBDeps, queue: string): Promise<boolean> {
  console.log('deps:', deps.useSupabase);
  if (deps.useSupabase) {
    const { data, error } = await deps.supabase
      .from('fsm_instance')
      .select('id, fsm_name, fsm_version')
      .eq('id', queue)
      .limit(1);
    if (error) {
      console.error('Error checking queue existence (supabase):', error);
      return false;
    }
    // Return false if data is empty array or falsy
    return Array.isArray(data) ? data[0] : !!data;
  } else {
    // Drizzle/pg: Use positional parameters ($1) only if supported. Otherwise, interpolate safely.
    // For Deno Postgres and Drizzle, use parameterized query with ?
    const result = await deps.db.execute(
      `SELECT id FROM fsm_instance WHERE id = '${queue}';`
    );
    return Array.isArray(result.rows) ? result.rows[0] : !!result.rows;
  }
}



/**
 * Checks whether a PGMQ queue with the given name exists in the database.
 * Uses the `public.list_queues()` wrapper when available.
 * @param deps - DBDeps containing either supabase or drizzle client
 * @param queueName - The PGMQ queue name to check
 * @returns Promise<boolean>
 */
export async function pgmqQueueExists(deps: DBDeps, queueName: string): Promise<boolean> {
  if (!queueName) return false;
  if (deps.useSupabase) {
    try {
      const { data, error } = await deps.supabase.rpc('list_queues');
      if (error) {
        console.error('Error calling list_queues RPC (supabase):', error);
        return false;
      }
      if (!Array.isArray(data)) return false;
      return data.some((q: any) => q?.name === queueName || q?.queue_name === queueName);
    } catch (err) {
      console.error('Unexpected error checking pgmq queues (supabase):', err);
      return false;
    }
  } else {
    try {
      const res = await deps.db.execute(`SELECT * FROM public.list_queues();`);
      const rows = res.rows ?? [];
      return rows.some((r: any) => r?.name === queueName || r?.queue_name === queueName);
    } catch (err) {
      console.error('Unexpected error checking pgmq queues (direct):', err);
      return false;
    }
  }
}
