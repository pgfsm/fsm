import { initialTransition, transition } from "xstate";
import { diff } from "json-diff-ts";
import { Pool } from "pg";

import machineConfig from "./machine.ts";
import { resolveStateValue } from "../../../../fsm-core-db-ts/src/fsm-helper.ts";
import { macrostep_v2 } from "../../../../fsm-core-ts-hono-deno/worker/fsmworker-helper.ts";
import { replaceUnderscoresWithSpaces, replaceSpacesWithUnderscores } from "@fsm/compiler";

const pool = new Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
});

const dbDeps = {
  useSupabase: false,
  db: pool,
};

Deno.test.ignore(
  "initialTransition_event: Event: Test macrostep_v2 for initialTransition_event",
  async () => {
    try {
      const [initialState] = initialTransition(machineConfig);

      const fsm_name = "creditCheck";
      const fsm_version = "20250102030405";
      const queueName = `${fsm_name}_${fsm_version}`;
      const msg = {
        msg_id: 1,
        message: {
          type: "initialTransition_event",
          payload: {},
        },
      };

      const fsm_instance_row = {};
      const resolved_state_value = await resolveStateValue(
        dbDeps,
        {},
        fsm_name,
        fsm_version,
      );

      let actionsModule: any = null;
      try {
        actionsModule = await import(`./typescript/actions/index.ts`);
      } catch (err) {
        console.warn(`⚠️ Could not load actions for ${fsm_name}/${fsm_version}:`, err?.message || err);
      }

      let delayModule: any = null;
      try {
        delayModule = await import(`./typescript/delays/index.ts`);
      } catch (err) {
        console.warn(`⚠️ Could not load delays for ${fsm_name}/${fsm_version}:`, err?.message || err);
      }

      const macrostepState: any = await macrostep_v2(
        dbDeps,
        queueName,
        msg as any,
        fsm_instance_row as any,
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
          "macrostep_v2 state does not match initialState state for initialTransition_event",
        );
      }
    } catch (err) {
      console.error("Test failed:", err);
    }
  },
);

Deno.test.ignore("Submit: Event: Test macrostep_v2 for Submit event", async () => {
  try {
    const [initialState] = initialTransition(machineConfig);
    const initialStateJson = initialState.toJSON();

    const event_data = { type: "Submit", payload: {} };
    const resolvedInitialState = machineConfig.resolveState(initialStateJson as any);
    const [nextState] = transition(machineConfig, resolvedInitialState, event_data);

    const fsm_name = "creditCheck";
    const fsm_version = "20250102030405";
    const queueName = `${fsm_name}_${fsm_version}`;
    const msg = { msg_id: 1, message: event_data };

    const fsm_instance_row = {};
    const resolved_state_value = await resolveStateValue(
      dbDeps,
      initialStateJson.value,
      fsm_name,
      fsm_version,
    );

    let actionsModule: any = null;
    try {
      actionsModule = await import(`./typescript/actions/index.ts`);
    } catch (err) {
      console.warn(`⚠️ Could not load actions for ${fsm_name}/${fsm_version}:`, err?.message || err);
    }

    let delayModule: any = null;
    try {
      delayModule = await import(`./typescript/delays/index.ts`);
    } catch (err) {
      console.warn(`⚠️ Could not load delays for ${fsm_name}/${fsm_version}:`, err?.message || err);
    }

    const macrostepState: any = await macrostep_v2(
      dbDeps,
      queueName,
      msg as any,
      fsm_instance_row as any,
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
      throw new Error("macrostep_v2 state does not match nextState state for Submit event");
    }
  } catch (err) {
    console.error("Test failed:", err);
    throw new Error("Test failed:");
  }
});

Deno.test(
  "xstate.done.actor.0.(machine).creditCheck.Verifying Credentials: Event: Test macrostep_v2 for xstate.done.actor.0.(machine).creditCheck.Verifying Credentials event",
  async () => {
    try {
      const [initialState] = initialTransition(machineConfig);
      const initialStateJson = initialState.toJSON();

      const event_data = { type: "Submit", payload: {} };
      const resolvedInitialState = machineConfig.resolveState(initialStateJson as any);
      const [nextState] = transition(machineConfig, resolvedInitialState, event_data);

      const nextStateJson = nextState.toJSON();

      const event_data1 = {
        type: "xstate.done.actor.0.(machine).creditCheck.Verifying Credentials",
        payload: {},
      };
      const resolvedNextState = machineConfig.resolveState(nextStateJson as any);
      const [nextState1, actions1] = transition(machineConfig, resolvedNextState, event_data1);

      const fsm_name = "creditCheck";
      const fsm_version = "20250102030405";
      const queueName = `${fsm_name}_${fsm_version}`;
      const msg = { msg_id: 1, message: event_data1 };

      const fsm_instance_row = {};
      const resolved_state_value = await resolveStateValue(
        dbDeps,
        replaceSpacesWithUnderscores(resolvedNextState.value),
        fsm_name,
        fsm_version,
      );

      let actionsModule: any = null;
      try {
        actionsModule = await import(`./typescript/actions/index.ts`);
        console.log(`📦 Loaded actions for ${fsm_name}/${fsm_version}`);
      } catch (err) {
        console.warn(`⚠️ Could not load actions for ${fsm_name}/${fsm_version}:`, err?.message || err);
      }

      let delayModule: any = null;
      try {
        delayModule = await import(`./typescript/delays/index.ts`);
        console.log(`📦 Loaded delays for ${fsm_name}/${fsm_version}`);
      } catch (err) {
        console.warn(`⚠️ Could not load delays for ${fsm_name}/${fsm_version}:`, err?.message || err);
      }

      const macrostepState: any = await macrostep_v2(
        dbDeps,
        queueName,
        msg as any,
        fsm_instance_row as any,
        resolved_state_value,
        fsm_name,
        fsm_version as any,
        actionsModule,
        delayModule,
      );

      const macroStepValueWithSpaces = replaceUnderscoresWithSpaces(
        macrostepState.fsm_instance_data_save_fsm_state,
      );
      const changes = diff(macroStepValueWithSpaces, nextState1.value);

      if (changes.length > 0) {
        throw new Error(
          "macrostep_v2 state does not match nextState1 state for xstate.done.actor.0.(machine).creditCheck.Verifying Credentials event",
        );
      }

      if (
        macrostepState.exit_actions.length +
          macrostepState.transition_actions.length +
          macrostepState.entry_actions.length !== actions1.length
      ) {
        throw new Error(
          "macrostep_v2 actions length does not match expected actions length for xstate.done.actor.0.(machine).creditCheck.Verifying Credentials event",
        );
      }
    } catch (err) {
      console.error("Test failed:", err);
      throw new Error("Test failed:");
    }
  },
);
