import { initialTransition } from "xstate";
import { assertEquals } from "@std/assert";
import { diff } from "json-diff-ts";
import { Pool } from "pg";
/// <reference lib="deno.ns" />

import machineConfig from "./machine.ts";
import { resolveStateValue } from "@fsm/db";
import { replaceSpacesWithUnderscores, replaceUnderscoresWithSpaces } from "@fsm/compiler";

const fsm_name = "creditCheck";
const fsm_version = "v01";

// Test 1: empty state {} — corresponds to the initial xstate state
Deno.test({
  name: "resolveStateValue: empty state {} matches xstate resolveState for initial state",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const dbDeps = { useSupabase: false, db: pool };
    try {
      const initialStateJson = {};

      const resolvedXstateState = machineConfig.resolveState({
        value: initialStateJson,
        context: {} as any,
      });

      const result = await resolveStateValue(dbDeps, initialStateJson, fsm_name, fsm_version);
      const changes = diff(replaceUnderscoresWithSpaces(result?.json), resolvedXstateState.value);
      assertEquals(
        changes.length,
        0,
        "resolveStateValue({}) should match xstate resolveState for initial state",
      );
    } finally {
      await pool.end();
    }
  },
});

// Test 2: "Entering Information" state value — initial xstate state after replaceSpacesWithUnderscores
Deno.test.ignore("resolveStateValue: Entering Information state matches xstate resolveState", async () => {
  const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
  const dbDeps = { useSupabase: false, db: pool };
  try {
    const [initialState] = initialTransition(machineConfig);
    const initialStateJson = initialState.toJSON();
    const resolvedXstateState = machineConfig.resolveState(initialStateJson as any);

    const stateValue = replaceSpacesWithUnderscores(resolvedXstateState.value);
    const result = await resolveStateValue(dbDeps, stateValue, fsm_name, fsm_version);

    assertEquals(
      replaceUnderscoresWithSpaces(result?.json),
      resolvedXstateState.value,
      "resolveStateValue for Entering Information should match xstate resolveState",
    );
  } finally {
    await pool.end();
  }
});

// Test 3: "Verifying Credentials" state — state after Submit event
Deno.test({
  name: "resolveStateValue: should match xstate resolveState for a given state",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const dbDeps = { useSupabase: false, db: pool };
    try {
      const initialStateJson = {
        "creditCheck": {
          "CheckingCreditScores": {
            "CheckingGavperian": "CheckingForExistingReport",
          },
        },
      };

      const resolvedXstateState = machineConfig.resolveState({
        value: initialStateJson,
        context: {} as any,
      });

      const result = await resolveStateValue(dbDeps, initialStateJson, fsm_name, fsm_version);
      const changes = diff(replaceUnderscoresWithSpaces(result?.json), resolvedXstateState.value);
      assertEquals(
        changes.length,
        0,
        "resolveStateValue({}) should match xstate resolveState for initial state",
      );
    } finally {
      await pool.end();
    }
  },
});
