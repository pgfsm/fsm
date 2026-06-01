import { initialTransition, transition } from "xstate";
import { diff } from "json-diff-ts";
import { assertEquals } from "@std/assert";
import { Pool } from "pg";

import machineConfig from "./machine.ts";
import { resolveStateValue } from "@pgfsm/db";
import { macrostep_v2 } from "@pgfsm/worker";
import { replaceSpacesWithUnderscores, replaceUnderscoresWithSpaces } from "@pgfsm/compiler";
import { Json } from "@pgfsm/db/database.types";
import type { DBDeps } from "@pgfsm/db";

const fsm_name = "creditCheck";
const fsm_version = "v01";
const queueName = `${fsm_name}_${fsm_version}`;

async function loadModule(path: string, label: string): Promise<any> {
  try {
    const mod = await import(path);
    console.log(`📦 Loaded ${label}`);
    return mod;
  } catch (err: any) {
    console.warn(`⚠️ Could not load ${label}:`, err?.message || err);
    return null;
  }
}

const fsmModuleDefinition = {
  actions: await loadModule(`./typescript/actions/index.ts`, "actions"),
  guards: await loadModule(`./typescript/guards/index.ts`, "guards"),
  delays: await loadModule(`./typescript/delays/index.ts`, "delays"),
  actors: await loadModule(`./typescript/actors/index.ts`, "actors"),
};

// Journey 1: initialTransition_event — FSM starts, no prior state
Deno.test({
  name: "Journey 1 — initialTransition_event: macrostep_v2 state matches xstate initialTransition",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const dbDeps: DBDeps = { useSupabase: false, db: pool };

    try {
      // xstate initial state
      const [initialState] = initialTransition(machineConfig);

      // prepare inputs for macrostep_v2
      const resolved_state_value = await resolveStateValue(dbDeps, {}, fsm_name, fsm_version);

      // fsm_instance_row can be mostly empty for initialTransition since there's no prior state, but we include the resolved_state_value to simulate the DB having processed the initial state
      const fsm_instance_row = {
          childrens: {} as Json,
          ended_at: "2025-01-02T03:04:05.000Z",
          fsm_instance_context: {},
          fsm_instance_error: null,
          fsm_instance_output: null,
          fsm_instance_state: resolved_state_value?.json,
          fsm_instance_status: null,
          fsm_instance_xstate_state: null,
          fsm_name: fsm_name,
          fsm_version: fsm_version,
          id: "test-instance-id",
          parent: null,
          started_at: "2025-01-02T03:04:05.000Z",
          total_promise_queue_data: null,
          total_schedule_queue_data: null,
      };
      const msg = {
        msg_id: 1,
        message: {
          event_data : { 
            event_type: "initialTransition_event",
            event_payload: {},
          }
       },
      };

      const macrostepState: any = await macrostep_v2(
        dbDeps,
        queueName,
        msg as any,
        fsm_instance_row,
        resolved_state_value,
        fsm_name,
        fsm_version,
        fsmModuleDefinition,
      );

      const macroStepValueWithSpaces = replaceUnderscoresWithSpaces(
        macrostepState.fsm_instance_data_save_fsm_state,
      );
      const changes = diff(macroStepValueWithSpaces, initialState.value);

      assertEquals(
        changes.length,
        0,
        `State mismatch for initialTransition_event.\nDiff: ${JSON.stringify(changes, null, 2)}`,
      );
    } finally {
      await pool.end();
    }
  },
});

// Journey 2: Submit event — Entering Information → Verifying Credentials
Deno.test({
  name: "Journey 2 — Submit: macrostep_v2 state matches xstate transition after Submit",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const dbDeps: DBDeps = { useSupabase: false, db: pool };

    try {
      const [initialState] = initialTransition(machineConfig);
      const initialStateJson  = initialState.toJSON() as any;

      const submitEvent = { type: "Submit", payload: {} };
      const resolvedInitialState = machineConfig.resolveState(initialStateJson as any);
      const [nextState, actions] = transition(machineConfig, resolvedInitialState, submitEvent);

      // prepare inputs for macrostep_v2
      const resolved_state_value = await resolveStateValue(dbDeps, replaceSpacesWithUnderscores(resolvedInitialState.value), fsm_name, fsm_version);

      const fsm_instance_row = {
          childrens: {} as Json,
          ended_at: "2025-01-02T03:04:05.000Z",
          fsm_instance_context: {},
          fsm_instance_error: null,
          fsm_instance_output: null,
          fsm_instance_state: resolved_state_value?.json,
          fsm_instance_status: null,
          fsm_instance_xstate_state: null,
          fsm_name: fsm_name,
          fsm_version: fsm_version,
          id: "test-instance-id",
          parent: null,
          started_at: "2025-01-02T03:04:05.000Z",
          total_promise_queue_data: null,
          total_schedule_queue_data: null,
      };
     
      const msg = {
        msg_id: 1,
        message: {
          event_data : { 
            event_type: submitEvent.type,
            event_payload: submitEvent.payload,
          }
       },
      };

      const macrostepState: any = await macrostep_v2(
        dbDeps,
        queueName,
        msg as any,
        fsm_instance_row as any,
        resolved_state_value,
        fsm_name,
        fsm_version,
        fsmModuleDefinition,
      );

      const macroStepValueWithSpaces = replaceUnderscoresWithSpaces(
        macrostepState.fsm_instance_data_save_fsm_state,
      );
      const changes = diff(macroStepValueWithSpaces, nextState.value);

      assertEquals(
        changes.length,
        0,
        `State mismatch for Submit event.\nDiff: ${JSON.stringify(changes, null, 2)}`,
      );
      const totalMacroActions =
        macrostepState.exit_actions.length +
        macrostepState.transition_actions.length +
        macrostepState.entry_actions.length;
      assertEquals(
        totalMacroActions,
        actions.length,
        `Action count mismatch: macrostep_v2 has ${totalMacroActions}, xstate has ${actions.length}`,
      );
    } finally {
      await pool.end();
    }
  },
});

// Journey 3: xstate.done.actor — Verifying Credentials complete → CheckingCreditScores (parallel)
Deno.test({
  name: "Journey 3 — xstate.done.actor (Verifying Credentials): macrostep_v2 state and actions match xstate",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const dbDeps: DBDeps = { useSupabase: false, db: pool };

    try {
      // Step 1: advance xstate to "Verifying Credentials"
      const [initialState] = initialTransition(machineConfig);
      const initialStateJson = initialState.toJSON();

      const resolvedInitialState = machineConfig.resolveState(initialStateJson as any);
      const [afterSubmit] = transition(machineConfig, resolvedInitialState, { type: "Submit", payload: {} });
      const afterSubmitJson = afterSubmit.toJSON();

      // Step 2: advance xstate past done actor event
      const doneEvent = {
        type: "xstate.done.actor.0.(machine).creditCheck.Verifying Credentials",
        payload: {},
      };
      const resolvedAfterSubmit = machineConfig.resolveState(afterSubmitJson as any);
      const [nextState, actions] = transition(machineConfig, resolvedAfterSubmit, doneEvent);

      // Step 3: call macrostep_v2 from "Verifying Credentials" with done actor event
      // prepare inputs for macrostep_v2
      const resolved_state_value = await resolveStateValue(
        dbDeps,
        replaceSpacesWithUnderscores(resolvedAfterSubmit.value),
        fsm_name,
        fsm_version,
      );
      const fsm_instance_row = {
          childrens: {} as Json,
          ended_at: "2025-01-02T03:04:05.000Z",
          fsm_instance_context: {},
          fsm_instance_error: null,
          fsm_instance_output: null,
          fsm_instance_state: resolved_state_value?.json,
          fsm_instance_status: null,
          fsm_instance_xstate_state: null,
          fsm_name: fsm_name,
          fsm_version: fsm_version,
          id: "test-instance-id",
          parent: null,
          started_at: "2025-01-02T03:04:05.000Z",
          total_promise_queue_data: null,
          total_schedule_queue_data: null,
      };

      const msg = {
        msg_id: 1,
        message: {
          event_data : { 
            event_type: doneEvent.type,
            event_payload: doneEvent.payload,
          }
       },
      };

      const macrostepState: any = await macrostep_v2(
        dbDeps,
        queueName,
        msg as any,
        fsm_instance_row as any,
        resolved_state_value,
        fsm_name,
        fsm_version,
        fsmModuleDefinition,
      );

      // Compare state
      const macroStepValueWithSpaces = replaceUnderscoresWithSpaces(
        macrostepState.fsm_instance_data_save_fsm_state,
      );
      const changes = diff(macroStepValueWithSpaces, nextState.value);
      assertEquals(
        changes.length,
        0,
        `State mismatch for done actor event.\nDiff: ${JSON.stringify(changes, null, 2)}`,
      );

      // Compare action count
      const totalMacroActions =
        macrostepState.exit_actions.length +
        macrostepState.transition_actions.length +
        macrostepState.entry_actions.length;
      assertEquals(
        totalMacroActions,
        actions.length,
        `Action count mismatch: macrostep_v2 has ${totalMacroActions}, xstate has ${actions.length}`,
      );
    } finally {
      await pool.end();
    }
  },
});
