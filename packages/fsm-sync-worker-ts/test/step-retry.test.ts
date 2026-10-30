import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { runStepWithRetry, sleep } from "../src/fsmlet/step-retry.ts";
import {
  callSyncOperation,
  maxAttemptsFor,
  retryDelayMs,
  SyncOperationError,
  validateSyncOperationRetry,
} from "../src/fsmlet/sync-operation-error.ts";
import { runActionImplementation } from "../src/fsmlet/fsmworker-helper.ts";
import type { SyncOperationRegistration } from "../src/fsmlet/type.ts";

const guardThrew = () =>
  new SyncOperationError("guard", "isAdult", new Error("no user"));

/**
 * A step that fails with the given errors in turn, then saves; records every
 * wait and whether the error was saved.
 */
function harness(
  failures: unknown[],
  opts: { firstAttempt?: number; maxAttempts?: number } = {},
) {
  const waits: number[] = [];
  const savedErrors: unknown[] = [];
  let attempts = 0;
  const run = () =>
    runStepWithRetry({
      firstAttempt: opts.firstAttempt ?? 1,
      maxAttempts: opts.maxAttempts ?? 3,
      eventType: "APPROVE",
      attemptStep: () => {
        const failure = failures[attempts++];
        return failure === undefined
          ? Promise.resolve("saved")
          : Promise.reject(failure);
      },
      saveError: (error) => {
        savedErrors.push(error);
        return Promise.resolve("error saved");
      },
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
  return { run, waits, savedErrors, attempts: () => attempts };
}

Deno.test("a step that throws then succeeds is saved normally, after waits of 1 s, 2 s (SPEC-014)", async () => {
  const h = harness([guardThrew(), guardThrew()]);
  assertEquals(await h.run(), { outcome: "saved", result: "saved" });
  assertEquals(h.attempts(), 3);
  assertEquals(h.waits, [1000, 2000]);
  assertEquals(h.savedErrors, []);
});

Deno.test("after maxAttempts failures the error is saved: kind, name, message, attempts, eventType", async () => {
  const h = harness([guardThrew(), guardThrew(), guardThrew(), guardThrew()]);
  assertEquals(await h.run(), {
    outcome: "error_saved",
    result: "error saved",
  });
  assertEquals(h.attempts(), 3);
  assertEquals(h.waits, [1000, 2000]);
  assertEquals(h.savedErrors, [
    {
      kind: "guard",
      name: "isAdult",
      message: "no user",
      attempts: 3,
      eventType: "APPROVE",
    },
  ]);
});

Deno.test("maxAttempts 1 is XState's behaviour: the first throw is saved as an error, with no wait", async () => {
  const h = harness([guardThrew()], { maxAttempts: 1 });
  assertEquals((await h.run()).outcome, "error_saved");
  assertEquals(h.attempts(), 1);
  assertEquals(h.waits, []);
});

Deno.test("a redelivered message's count starts at its read_ct", async () => {
  // Third delivery of a message with 3 attempts: one attempt left.
  const h = harness([guardThrew(), guardThrew()], { firstAttempt: 3 });
  assertEquals((await h.run()).outcome, "error_saved");
  assertEquals(h.attempts(), 1);
  assertEquals((h.savedErrors[0] as { attempts: number }).attempts, 3);
  // Past maxAttempts already (several redeliveries): still one attempt.
  const late = harness([undefined], { firstAttempt: 7 });
  assertEquals((await late.run()).outcome, "saved");
});

Deno.test("platform errors never count toward maxAttempts and back off to 30 s", async () => {
  const dbDown = () => new Error("connection refused");
  const h = harness([
    ...Array.from({ length: 8 }, dbDown),
    guardThrew(),
    dbDown(),
  ]);
  assertEquals((await h.run()).outcome, "saved");
  assertEquals(h.savedErrors, []);
  // 8 platform failures: 1, 2, 4, 8, 16, 30, 30, 30 s; then the guard's
  // first failure (1 s); the platform count restarted after it (1 s).
  assertEquals(h.waits, [
    1000,
    2000,
    4000,
    8000,
    16000,
    30000,
    30000,
    30000,
    1000,
    1000,
  ]);
});

Deno.test("a platform error while saving the error is retried; the error is saved once", async () => {
  let saveCalls = 0;
  const result = await runStepWithRetry({
    firstAttempt: 1,
    maxAttempts: 1,
    eventType: "APPROVE",
    attemptStep: () => Promise.reject(guardThrew()),
    saveError: () => {
      saveCalls++;
      return saveCalls < 3
        ? Promise.reject(new Error("db down"))
        : Promise.resolve("ok");
    },
    wait: () => Promise.resolve(),
  });
  assertEquals(result, { outcome: "error_saved", result: "ok" });
  assertEquals(saveCalls, 3);
});

Deno.test("an abort stops retrying without saving anything", async () => {
  const controller = new AbortController();
  const result = await runStepWithRetry({
    firstAttempt: 1,
    maxAttempts: 5,
    eventType: "APPROVE",
    signal: controller.signal,
    attemptStep: () => Promise.reject(guardThrew()),
    saveError: () => Promise.reject(new Error("must not be called")),
    wait: () => {
      controller.abort();
      return Promise.resolve();
    },
  });
  assertEquals(result, { outcome: "aborted" });
});

Deno.test("sleep resolves early on abort", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const slept = sleep(10_000, controller.signal);
  controller.abort();
  await slept;
  assertEquals(Date.now() - started < 1000, true);
});

Deno.test("retryDelayMs doubles from 1 s, capped at 30 s", () => {
  assertEquals([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs), [
    1000,
    2000,
    4000,
    8000,
    16000,
    30000,
    30000,
  ]);
});

Deno.test("maxAttemptsFor: the FSM's own value, else the fsmlet's, else 3", () => {
  assertEquals(maxAttemptsFor(undefined, "creditCheck"), 3);
  assertEquals(maxAttemptsFor({ maxAttempts: 5 }, "creditCheck"), 5);
  assertEquals(
    maxAttemptsFor({
      maxAttempts: 5,
      fsms: { creditCheck: { maxAttempts: 1 } },
    }, "creditCheck"),
    1,
  );
  assertEquals(
    maxAttemptsFor({ fsms: { creditCheck: { maxAttempts: 1 } } }, "other"),
    3,
  );
});

Deno.test("validateSyncOperationRetry rejects anything but an integer ≥ 1", () => {
  validateSyncOperationRetry(undefined);
  validateSyncOperationRetry({
    maxAttempts: 1,
    fsms: { a: { maxAttempts: 10 } },
  });
  for (
    const bad of [
      { maxAttempts: 0 },
      { maxAttempts: 2.5 },
      { maxAttempts: "3" as unknown as number },
      { fsms: { creditCheck: { maxAttempts: -1 } } },
      { fsms: { creditCheck: {} as { maxAttempts: number } } },
    ]
  ) {
    let threw = false;
    try {
      validateSyncOperationRetry(bad);
    } catch (err) {
      threw = err instanceof TypeError;
    }
    assertEquals(threw, true, JSON.stringify(bad));
  }
});

Deno.test("callSyncOperation wraps a throw, sync or async, with its kind and name", async () => {
  const sync = await assertRejects(
    () =>
      callSyncOperation("delay", "backoff", () => {
        throw new Error("bad");
      }),
    SyncOperationError,
  );
  assertEquals([sync.kind, sync.operation, (sync.cause as Error).message], [
    "delay",
    "backoff",
    "bad",
  ]);
  const asyncErr = await assertRejects(
    () => callSyncOperation("input", "mapper", () => Promise.reject("nope")),
    SyncOperationError,
  );
  assertEquals(asyncErr.cause, "nope");
  assertEquals(await callSyncOperation("guard", "g", () => true), true);
});

const meta = {} as Parameters<typeof runActionImplementation>[4];
const registrations = (handler: (...args: unknown[]) => unknown) =>
  [{
    fsmName: "f",
    fsmVersion: "v01",
    syncOperationType: "action",
    syncOperationName: "assignUser",
    handler,
  }] as unknown as SyncOperationRegistration[];

Deno.test("an action that throws fails the step instead of being skipped (SPEC-014)", async () => {
  const error = await assertRejects(
    () =>
      runActionImplementation(
        "entry",
        { type: "assignUser" },
        registrations(() => {
          throw new Error("boom");
        }),
        { n: 1 },
        meta,
      ),
    SyncOperationError,
  );
  assertInstanceOf(error, SyncOperationError);
  assertEquals([error.kind, error.operation], ["action", "assignUser"]);
});

Deno.test("an action without an implementation is still skipped, as in XState", async () => {
  assertEquals(
    await runActionImplementation(
      "entry",
      { type: "unknownAction" },
      registrations(() => ({})),
      { n: 1 },
      meta,
    ),
    { n: 1 },
  );
});
