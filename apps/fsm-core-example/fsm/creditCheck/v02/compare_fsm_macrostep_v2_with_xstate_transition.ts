import { initialTransition, transition } from "xstate";
import { diff } from "json-diff-ts";
import { Pool } from "pg";

import machineConfig from "./machine.ts";
import { resolveStateValue } from "@pgfsm/db";
import { macrostep_v2 } from "../../../../fsm-core-ts-hono-deno/worker/fsmworker-helper.ts";
import { replaceUnderscoresWithSpaces, replaceSpacesWithUnderscores } from "@pgfsm/compiler";

const pool = new Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
});

const dbDeps = {
  db: pool,
};

const fsm_name = "creditCheck";
const fsm_version = "v02";
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

Deno.test.ignore(
  "initialTransition_event: Test macrostep_v2 for initialTransition_event",
  async () => {
    const [initialState] = initialTransition(machineConfig);

    const msg = {
      msg_id: 1,
      message: { type: "initialTransition_event", payload: {} },
    };

    const resolved_state_value = await resolveStateValue(dbDeps, {}, fsm_name, fsm_version);
    const actionsModule = await loadModule(`./typescript/actions/index.ts`, "actions");
    const delayModule = await loadModule(`./typescript/delays/index.ts`, "delays");

    const macrostepState: any = await macrostep_v2(
      dbDeps,
      queueName,
      msg as any,
      {} as any,
      resolved_state_value,
      fsm_name,
      fsm_version as any,
      actionsModule,
      delayModule,
    );

    const macroStepValueWithSpaces = replaceUnderscoresWithSpaces(
      macrostepState.fsm_instance_data_save_fsm_state,
    );
    const changes = diff(macroStepValueWithSpaces, initialState.value);

    if (changes.length > 0) {
      throw new Error(
        "macrostep_v2 state does not match initialState for initialTransition_event",
      );
    }
  },
);

Deno.test.ignore(
  "Submit: Test macrostep_v2 for Submit event",
  async () => {
    const [initialState] = initialTransition(machineConfig);
    const initialStateJson = initialState.toJSON();

    const event_data = { type: "Submit", payload: {} };
    const resolvedInitialState = machineConfig.resolveState(initialStateJson as any);
    const [nextState] = transition(machineConfig, resolvedInitialState, event_data);

    const msg = { msg_id: 1, message: event_data };

    const resolved_state_value = await resolveStateValue(
      dbDeps,
      initialStateJson.value,
      fsm_name,
      fsm_version,
    );
    const actionsModule = await loadModule(`./typescript/actions/index.ts`, "actions");
    const delayModule = await loadModule(`./typescript/delays/index.ts`, "delays");

    const macrostepState: any = await macrostep_v2(
      dbDeps,
      queueName,
      msg as any,
      {} as any,
      resolved_state_value,
      fsm_name,
      fsm_version as any,
      actionsModule,
      delayModule,
    );

    const macroStepValueWithSpaces = replaceUnderscoresWithSpaces(
      macrostepState.fsm_instance_data_save_fsm_state,
    );
    const changes = diff(macroStepValueWithSpaces, nextState.value);

    if (changes.length > 0) {
      throw new Error(
        "macrostep_v2 state does not match nextState for Submit event",
      );
    }
  },
);

Deno.test(
  "xstate.done.actor — Verifying Credentials: Test macrostep_v2 matches XState transition",
  async () => {
    // step 1: get XState state after Submit
    const [initialState] = initialTransition(machineConfig);
    const initialStateJson = initialState.toJSON();

    const submitEvent = { type: "Submit", payload: {} };
    const resolvedInitialState = machineConfig.resolveState(initialStateJson as any);
    const [afterSubmit] = transition(machineConfig, resolvedInitialState, submitEvent);
    const afterSubmitJson = afterSubmit.toJSON();

    // step 2: get XState state after verifyCredentials done
    const doneEvent = {
      type: "xstate.done.actor.0.(machine).creditCheck.Verifying Credentials",
      payload: {},
    };
    const resolvedAfterSubmit = machineConfig.resolveState(afterSubmitJson as any);
    const [nextState, actions] = transition(machineConfig, resolvedAfterSubmit, doneEvent);

    // step 3: call macrostep_v2 at "Verifying Credentials" state
    const msg = { msg_id: 1, message: doneEvent };
    const resolved_state_value = await resolveStateValue(
      dbDeps,
      replaceSpacesWithUnderscores(resolvedAfterSubmit.value),
      fsm_name,
      fsm_version,
    );
    const actionsModule = await loadModule(`./typescript/actions/index.ts`, "actions");
    const delayModule = await loadModule(`./typescript/delays/index.ts`, "delays");

    const macrostepState: any = await macrostep_v2(
      dbDeps,
      queueName,
      msg as any,
      {} as any,
      resolved_state_value,
      fsm_name,
      fsm_version as any,
      actionsModule,
      delayModule,
    );

    // compare state value
    const macroStepValueWithSpaces = replaceUnderscoresWithSpaces(
      macrostepState.fsm_instance_data_save_fsm_state,
    );
    const changes = diff(macroStepValueWithSpaces, nextState.value);
    if (changes.length > 0) {
      throw new Error(
        `macrostep_v2 state does not match XState nextState.\nDiff: ${JSON.stringify(changes, null, 2)}`,
      );
    }

    // compare action count
    const totalMacroActions =
      macrostepState.exit_actions.length +
      macrostepState.transition_actions.length +
      macrostepState.entry_actions.length;
    if (totalMacroActions !== actions.length) {
      throw new Error(
        `macrostep_v2 action count (${totalMacroActions}) does not match XState actions (${actions.length})`,
      );
    }
  },
);
