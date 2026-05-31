import { initialTransition, transition } from "xstate";
import { diff } from "json-diff-ts";
import { assertEquals } from "@std/assert";
import { Pool } from "pg";

import machineConfig from "./machine.ts";
import { createAndStartFSMWorker, startFSMWorkerWithDBLock } from "@fsm/worker";
import { createFsmInstanceFromName, sendEventToFsmQueueWithEventLogs, getFsmDataResolveStateValue } from "@pgfsm/db";
import { replaceSpacesWithUnderscores, replaceUnderscoresWithSpaces } from "@fsm/compiler";
import type { DBDeps } from "@pgfsm/db";

const fsm_name = "creditCheck";
const fsm_version = "v01";
const verifiedModule = { fsmAbsFolderPath: import.meta.dirname };

// Poll getFsmDataResolveStateValue until predicate is satisfied or timeout
async function pollUntil(
  deps: DBDeps,
  queueName: string,
  predicate: (row: any) => boolean,
  timeoutMs = 6000,
  intervalMs = 300,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await getFsmDataResolveStateValue(deps, queueName);
    if (data?.fsm_instance_row && predicate(data.fsm_instance_row)) {
      return data.fsm_instance_row;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout: state predicate not satisfied for queue "${queueName}"`);
}

// Journey 1: createAndStartFSMWorker — verify initial DB state matches xstate initial state
Deno.test({
  name: "Journey 1 — createAndStartFSMWorker: initial DB state matches xstate initialTransition",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const deps: DBDeps = { useSupabase: false, db: pool };
    const activeLocks: Record<string, boolean> = {};
    const controller = new AbortController();

    try {
      const [xstateInitialState] = initialTransition(machineConfig);

      const fsm_instance = await createAndStartFSMWorker(
        deps,
        fsm_name,
        fsm_version,
        verifiedModule,
        activeLocks,
        false,
        controller.signal,
      );

      if (!fsm_instance) throw new Error("Failed to create FSM instance");

      // wait for worker to create instance and write initial state to DB
      await new Promise((r) => setTimeout(r, 10000));

      const data = await getFsmDataResolveStateValue(deps, fsm_instance.fsm_instance_id);
      if (!data) throw new Error("No FSM data found for instance");

      const dbStateWithSpaces = replaceUnderscoresWithSpaces(data.resolved_state_value.json.machine);
      const changes = diff(dbStateWithSpaces, xstateInitialState.value);

      assertEquals(
        changes.length,
        0,
        `Initial DB state does not match xstate.\nDiff: ${JSON.stringify(changes, null, 2)}`,
      );
    } finally {
      controller.abort();
      await pool.end();
    }
  },
});

// Journey 2: createAndStartFSMWorker + sendEventToFsmQueueWithEventLogs(Submit) — wait and compare with xstate
Deno.test({
  name: "Journey 2 — Submit: DB state after Submit matches xstate transition",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const deps: DBDeps = { useSupabase: false, db: pool };
    const activeLocks: Record<string, boolean> = {};
    const controller = new AbortController();

    try {
      const [initialState] = initialTransition(machineConfig);
      const resolvedInitialState = machineConfig.resolveState(initialState.toJSON() as any);
      const [afterSubmitXstate] = transition(machineConfig, resolvedInitialState, { type: "Submit", payload: {} });
      const expectedStateValue = afterSubmitXstate.value;

      const fsm_instance = await createAndStartFSMWorker(
        deps,
        fsm_name,
        fsm_version,
        verifiedModule,
        activeLocks,
        false,
        controller.signal,
      );

      if (!fsm_instance) throw new Error("Failed to create FSM instance");

      await sendEventToFsmQueueWithEventLogs(
        deps,
        fsm_instance.fsm_instance_id,
        "Submit",
        { type: "Submit", payload: {} },
      );

      // const row = await pollUntil(
      //   deps,
      //   fsm_instance.fsm_instance_id,
      //   (r) => {
      //     const stateWithSpaces = replaceUnderscoresWithSpaces(r.fsm_instance_state);
      //     return diff(stateWithSpaces, expectedStateValue).length === 0;
      //   },
      // );

      // wait for worker to finish processing event and writing new state to DB
      await new Promise((r) => setTimeout(r, 30000));

      const data = await getFsmDataResolveStateValue(deps, fsm_instance.fsm_instance_id);
      if (!data) throw new Error("No FSM data found for instance");

      
      const dbStateWithSpaces = replaceUnderscoresWithSpaces(data.fsm_instance_row.fsm_instance_state);
      const changes = diff(dbStateWithSpaces, expectedStateValue);

      assertEquals(
        changes.length,
        0,
        `DB state after Submit does not match xstate.\nDiff: ${JSON.stringify(changes, null, 2)}`,
      );
    } finally {
      controller.abort();
      await pool.end();
    }
  },
});

// Journey 3: createFsmInstanceFromName + startFSMWorkerWithDBLock — same Submit journey via lower-level API
Deno.test({
  name: "Journey 3 — startFSMWorkerWithDBLock: DB state after Submit matches xstate transition",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const deps: DBDeps = { useSupabase: false, db: pool };
    const activeLocks: Record<string, boolean> = {};
    const controller = new AbortController();

    try {
      const [initialState] = initialTransition(machineConfig);
      const resolvedInitialState = machineConfig.resolveState(initialState.toJSON() as any);
      const [afterSubmitXstate] = transition(machineConfig, resolvedInitialState, { type: "Submit", payload: {} });
      const expectedStateValue = afterSubmitXstate.value;

      const fsm_instance: any = await createFsmInstanceFromName(deps, fsm_name, fsm_version, true);
      if (!fsm_instance || !fsm_instance?.fsm_instance_id) throw new Error("Failed to create FSM instance");

      const acquired = await startFSMWorkerWithDBLock(
        deps,
        fsm_instance.fsm_instance_id,
        fsm_name,
        fsm_instance.fsm_version,
        activeLocks,
        verifiedModule,
        false,
        controller.signal,
      );

      if (!acquired) throw new Error(`Could not acquire DB lock for queue "${fsm_instance.fsm_instance_id}"`);

      await sendEventToFsmQueueWithEventLogs(
        deps,
        fsm_instance.fsm_instance_id,
        "Submit",
        { type: "Submit", payload: {} },
      );

      const row = await pollUntil(
        deps,
        fsm_instance.fsm_instance_id,
        (r) => {
          const stateWithSpaces = replaceUnderscoresWithSpaces(r.fsm_instance_state);
          return diff(stateWithSpaces, expectedStateValue).length === 0;
        },
      );

      const dbStateWithSpaces = replaceUnderscoresWithSpaces(row.fsm_instance_state);
      const changes = diff(dbStateWithSpaces, expectedStateValue);

      assertEquals(
        changes.length,
        0,
        `DB state after Submit does not match xstate.\nDiff: ${JSON.stringify(changes, null, 2)}`,
      );
    } finally {
      controller.abort();
      await pool.end();
    }
  },
});
