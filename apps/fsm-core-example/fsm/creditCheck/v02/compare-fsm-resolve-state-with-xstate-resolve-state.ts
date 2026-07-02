import { initialTransition, transition } from "xstate";
import { diff } from "json-diff-ts";
import { Pool } from "pg";

import machineConfig from "./machine.ts";
import { resolveStateValue } from "@pgfsm/db";
import {
  replaceSpacesWithUnderscores,
  replaceUnderscoresWithSpaces,
} from "@pgfsm/compiler";

const pool = new Pool({
  connectionString: Deno.env.get("DATABASE_URL"),
});

const dbDeps = {
  db: pool,
};

const fsm_name = "creditCheck";
const fsm_version = "v02";

Deno.test(
  "resolveState: initial state — DB resolveStateValue matches XState resolveState",
  async () => {
    const [initialState] = initialTransition(machineConfig);
    const initialStateJson = initialState.toJSON();

    const resolvedXState = machineConfig.resolveState(initialStateJson as any);

    const resolved = await resolveStateValue(
      dbDeps,
      replaceSpacesWithUnderscores(initialStateJson.value),
      fsm_name,
      fsm_version,
    );

    if (!resolved) {
      throw new Error("resolveStateValue returned null for initial state");
    }

    const dbValueWithSpaces = replaceUnderscoresWithSpaces(resolved.json);
    const changes = diff(dbValueWithSpaces, resolvedXState.value);

    if (changes.length > 0) {
      throw new Error(
        `resolveStateValue does not match XState resolveState for initial state.\nDiff: ${
          JSON.stringify(changes, null, 2)
        }`,
      );
    }
  },
);

Deno.test(
  "resolveState: after Submit event — DB resolveStateValue matches XState resolveState",
  async () => {
    const [initialState] = initialTransition(machineConfig);
    const initialStateJson = initialState.toJSON();

    const event_data = { type: "Submit", payload: {} };
    const resolvedInitialState = machineConfig.resolveState(
      initialStateJson as any,
    );
    const [nextState] = transition(
      machineConfig,
      resolvedInitialState,
      event_data,
    );
    const nextStateJson = nextState.toJSON();

    const resolvedXState = machineConfig.resolveState(nextStateJson as any);

    const resolved = await resolveStateValue(
      dbDeps,
      replaceSpacesWithUnderscores(nextStateJson.value),
      fsm_name,
      fsm_version,
    );

    if (!resolved) {
      throw new Error("resolveStateValue returned null after Submit event");
    }

    const dbValueWithSpaces = replaceUnderscoresWithSpaces(resolved.json);
    const changes = diff(dbValueWithSpaces, resolvedXState.value);

    if (changes.length > 0) {
      throw new Error(
        `resolveStateValue does not match XState resolveState after Submit.\nDiff: ${
          JSON.stringify(changes, null, 2)
        }`,
      );
    }
  },
);
