import { createActor, waitFor } from "xstate";
import { diff } from "json-diff-ts";
import { assertEquals } from "@std/assert";
import { Pool } from "pg";

import { machineWithProvider } from "./machineWithProvider.ts";
import { createAndStartFSMWorker } from "@fsm/worker";
import { sendFSMEvent, getFSMDataAndResolveStateValue } from "@fsm/db";
import type { DBDeps } from "@fsm/db";
import { replaceSpacesWithUnderscores, replaceUnderscoresWithSpaces } from "@fsm/compiler";

const fsm_name = "creditCheck";
const fsm_version = "v01";
const verifiedModule = { fsmAbsFolderPath: import.meta.dirname };

const SUBMIT_EVENT = {
  type: "Submit" as const,
  SSN: "123-45-6789",
  firstName: "John",
  lastName: "Doe",
};

// Poll getFSMDataAndResolveStateValue until predicate is satisfied or timeout
async function pollUntil(
  deps: DBDeps,
  instanceId: string,
  // deno-lint-ignore no-explicit-any
  predicate: (row: any) => boolean,
  timeoutMs = 6000,
  intervalMs = 300,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await getFSMDataAndResolveStateValue(deps, instanceId);
    if (data?.fsm_instance_row && predicate(data.fsm_instance_row)) {
      return data.fsm_instance_row;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout: state predicate not satisfied for instance "${instanceId}"`);
}

// Journey 1: createActor initial context matches DB initial context after createAndStartFSMWorker
Deno.test({
  name: "Journey 1 — createActor + createAndStartFSMWorker: initial context matches",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const input_fsm_context = {
      SSN: "123-45-6789",
      FirstName: "John",
      LastName: "Doe",
      GavUnionScore: 0,
      EquiGavinScore: 0,
      GavperianScore: 0,
      ErrorMessage: "",
      MiddleScore: 0,
      InterestRateOptions: [],

    };
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const deps: DBDeps = { useSupabase: false, db: pool };
    const activeLocks: Record<string, boolean> = {};
    const controller = new AbortController();
    const actor = createActor(machineWithProvider,{ input : input_fsm_context });
    actor.start();

    try {
      // xstate actor: get initial context (no events sent)
      const xstateSnapshot = actor.getSnapshot();

      // DB FSM: create instance and start worker
      const fsm_instance = await createAndStartFSMWorker(
        deps,
        fsm_name,
        fsm_version,
        verifiedModule,
        activeLocks,
        input_fsm_context,
        false,
        controller.signal,
      );

      if (!fsm_instance) throw new Error("Failed to create FSM instance");

      // Wait for worker to write initial state to DB
      await new Promise((r) => setTimeout(r, 10000));

      const data = await getFSMDataAndResolveStateValue(deps, fsm_instance.fsm_instance_id);
      if (!data) throw new Error("No FSM data found for instance");

      const dbStateWithSpaces = replaceUnderscoresWithSpaces(data.resolved_state_value.json.machine);
      const stateChanges = diff(dbStateWithSpaces, xstateSnapshot.value);

      const dbContext = data.fsm_instance_row.fsm_instance_context;
      const contextChanges = diff(dbContext, xstateSnapshot.context);

      assertEquals(
        stateChanges.length,
        0,
        `Initial state mismatch.\nDB: ${JSON.stringify(dbStateWithSpaces)}\nXState: ${JSON.stringify(xstateSnapshot.value)}\nDiff: ${JSON.stringify(stateChanges, null, 2)}`,
      );

      assertEquals(
        contextChanges.length,
        0,
        `Initial context mismatch.\nDB: ${JSON.stringify(dbContext)}\nXState: ${JSON.stringify(xstateSnapshot.context)}\nDiff: ${JSON.stringify(contextChanges, null, 2)}`,
      );
    } finally {
      actor.stop();
      controller.abort();
      await pool.end();
    }
  },
});

// Journey 2: Submit event — xstate actor context matches DB context after Submit
Deno.test({
  name: "Journey 2 — Submit: xstate actor context matches DB context",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const input_fsm_context = {
      SSN: "123-45-6789",
      FirstName: "John",
      LastName: "Doe",
      GavUnionScore: 0,
      EquiGavinScore: 0,
      GavperianScore: 0,
      ErrorMessage: "",
      MiddleScore: 0,
      InterestRateOptions: [],
    };
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const deps: DBDeps = { useSupabase: false, db: pool };
    const activeLocks: Record<string, boolean> = {};
    const controller = new AbortController();
    const actor = createActor(machineWithProvider, { input: input_fsm_context });
    actor.start();

    try {
      // DB FSM: create instance and start worker
      const fsm_instance = await createAndStartFSMWorker(
        deps,
        fsm_name,
        fsm_version,
        verifiedModule,
        activeLocks,
        input_fsm_context,
        false,
        controller.signal,
      );

      if (!fsm_instance) throw new Error("Failed to create FSM instance");

      // xstate actor: send Submit, get context (in Verifying Credentials, async actor not yet resolved)
      actor.send(SUBMIT_EVENT);
      const xstateSnapshot = actor.getSnapshot();

      // DB FSM: send Submit event
      await sendFSMEvent(
        deps,
        { type: "Submit", payload: {} },
        { source: "test" },
        0,
        "Submit",
        fsm_instance.fsm_instance_id,
      );

      // Wait for worker to process Submit and write new state to DB
      await new Promise((r) => setTimeout(r, 30000));

      const data = await getFSMDataAndResolveStateValue(deps, fsm_instance.fsm_instance_id);
      if (!data) throw new Error("No FSM data found for instance");

      const dbStateWithSpaces = replaceUnderscoresWithSpaces(data.resolved_state_value.json.machine);
      const stateChanges = diff(dbStateWithSpaces, xstateSnapshot.value);

      const dbContext = data.fsm_instance_row.fsm_instance_context;
      const contextChanges = diff(dbContext, xstateSnapshot.context);

      assertEquals(
        stateChanges.length,
        0,
        `Initial state mismatch.\nDB: ${JSON.stringify(dbStateWithSpaces)}\nXState: ${JSON.stringify(xstateSnapshot.value)}\nDiff: ${JSON.stringify(stateChanges, null, 2)}`,
      );

      assertEquals(
        contextChanges.length,
        0,
        `Initial context mismatch.\nDB: ${JSON.stringify(dbContext)}\nXState: ${JSON.stringify(xstateSnapshot.context)}\nDiff: ${JSON.stringify(contextChanges, null, 2)}`,
      );
    } finally {
      actor.stop();
      controller.abort();
      await pool.end();
    }
  },
});

// Journey 3: verifyCredentials resolves — xstate actor context matches DB context in CheckingCreditScores
Deno.test({
  name: "Journey 3 — verifyCredentials done: xstate actor context matches DB context in CheckingCreditScores",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const input_fsm_context = {
      SSN: "123-45-6789",
      FirstName: "John",
      LastName: "Doe",
      GavUnionScore: 0,
      EquiGavinScore: 0,
      GavperianScore: 0,
      ErrorMessage: "",
      MiddleScore: 0,
      InterestRateOptions: [],

    };
    const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });
    const deps: DBDeps = { useSupabase: false, db: pool };
    const activeLocks: Record<string, boolean> = {};
    const controller = new AbortController();
    const actor = createActor(machineWithProvider, { input: input_fsm_context });
    actor.start();

    try {
      // xstate actor: send Submit and wait for verifyCredentials to resolve → CheckingCreditScores
      actor.send(SUBMIT_EVENT);
      const xstateSnapshot = await waitFor(
        actor,
        (s) => {
          const value = s.value as Record<string, unknown>;
          const creditCheck = value.creditCheck;
          return (
            typeof creditCheck === "object" &&
            creditCheck !== null &&
            "CheckingCreditScores" in (creditCheck as Record<string, unknown>)
          );
        },
        { timeout: 5000 },
      );

      // DB FSM: create instance and start worker
      const fsm_instance = await createAndStartFSMWorker(
        deps,
        fsm_name,
        fsm_version,
        verifiedModule,
        activeLocks,
        input_fsm_context,
        false,
        controller.signal,
      );

      if (!fsm_instance) throw new Error("Failed to create FSM instance");

      // DB FSM: send Submit event
      await sendFSMEvent(
        deps,
        { type: "Submit", payload: {} },
        { source: "test" },
        0,
        "Submit",
        fsm_instance.fsm_instance_id,
      );

      // DB FSM: poll until state reaches CheckingCreditScores
      // await pollUntil(
      //   deps,
      //   fsm_instance.fsm_instance_id,
      //   (row) => {
      //     const state = row.fsm_instance_state as Record<string, unknown> | null;
      //     if (!state) return false;
      //     const creditCheck = state.creditCheck;
      //     return (
      //       typeof creditCheck === "object" &&
      //       creditCheck !== null &&
      //       "CheckingCreditScores" in (creditCheck as Record<string, unknown>)
      //     );
      //   },
      //   30000,
      // );

      await new Promise((r) => setTimeout(r, 30000));

      const data = await getFSMDataAndResolveStateValue(deps, fsm_instance.fsm_instance_id);
      if (!data) throw new Error("No FSM data found for instance");

      const dbStateWithSpaces = replaceUnderscoresWithSpaces(data.resolved_state_value.json.machine);
      const stateChanges = diff(dbStateWithSpaces, xstateSnapshot.value);

      const dbContext = data.fsm_instance_row.fsm_instance_context;
      const contextChanges = diff(dbContext, xstateSnapshot.context);

      assertEquals(
        stateChanges.length,
        0,
        `Initial state mismatch.\nDB: ${JSON.stringify(dbStateWithSpaces)}\nXState: ${JSON.stringify(xstateSnapshot.value)}\nDiff: ${JSON.stringify(stateChanges, null, 2)}`,
      );

      assertEquals(
        contextChanges.length,
        0,
        `Initial context mismatch.\nDB: ${JSON.stringify(dbContext)}\nXState: ${JSON.stringify(xstateSnapshot.context)}\nDiff: ${JSON.stringify(contextChanges, null, 2)}`,
      );
    } finally {
      actor.stop();
      controller.abort();
      await pool.end();
    }
  },
});
