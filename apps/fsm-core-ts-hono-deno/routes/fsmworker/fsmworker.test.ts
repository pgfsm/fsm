/* eslint-disable ts/ban-ts-comment */
/**
 * Tests for /fsmworker routes.
 * Requires vitest (add to deno.json imports: "vitest": "npm:vitest@^2")
 * and NODE_ENV=test in .env.
 *
 * Mocked dependencies:
 *   - fsm-core-db-ts/src/fsm-instance (isFSMInstancePresent)
 *   - fsm-core-db-ts/src/fsm-instance-lock (tryFSMDBLock, releaseFSMDBLock)
 *   - fsm-core-worker-ts/src/index (startFSMWorker)
 *   - middlewares/supabase (getSupabase)
 *   - routes/fsm/fsm.handlers (activeFSMLocks — shared module-level state)
 *
 * Note: fsmworker.handlers imports activeFSMLocks from fsm.handlers to check
 * for duplicate workers. Tests reset this state in beforeEach.
 */
import { testClient } from "hono/testing";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../middlewares/supabase.ts", () => ({
  getSupabase: vi.fn(() => null),
  supabaseMiddleware: vi.fn(() => (_c: unknown, next: () => void) => next()),
}));

vi.mock("../../../fsm-core-db-ts/src/fsm-instance.ts", () => ({
  isFSMInstancePresent: vi.fn(),
  createFSMInstanceFromName: vi.fn(),
  sendFSMEvent: vi.fn(),
}));

vi.mock("../../../fsm-core-db-ts/src/fsm-instance-lock.ts", () => ({
  tryFSMDBLock: vi.fn().mockResolvedValue(true),
  releaseFSMDBLock: vi.fn(),
}));

vi.mock("../../../fsm-core-worker-ts/src/index.ts", () => ({
  startFSMWorker: vi.fn().mockResolvedValue(undefined),
}));

import { isFSMInstancePresent } from "../../../fsm-core-db-ts/src/fsm-instance.ts";
import { tryFSMDBLock } from "../../../fsm-core-db-ts/src/fsm-instance-lock.ts";
import { createRouter } from "../../lib/create-app.ts";
// activeFSMLocks is shared between fsm and fsmworker handlers
import { activeFSMLocks } from "../fsm/fsm.handlers.ts";
import router from "./fsmworker.index.ts";

function makeTestApp() {
  const app = createRouter();
  app.use("*", (c, next) => {
    c.set("db", {} as never);
    return next();
  });
  app.route("/", router);
  return app;
}

const client = testClient(makeTestApp());

// ─── GET /fsmworker ──────────────────────────────────────────────────────────

describe("GET /fsmworker", () => {
  beforeEach(() => {
    Object.keys(activeFSMLocks).forEach((k) => delete activeFSMLocks[k]);
  });

  it("returns 200 with an empty data object when no workers are active", async () => {
    const res = await client.fsmworker.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
    expect(json.data).toEqual({});
  });

  it("reflects locks set via the shared activeFSMLocks object", async () => {
    activeFSMLocks["some-queue-id"] = true;
    const res = await client.fsmworker.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveProperty("some-queue-id", true);
  });
});

// ─── POST /fsmworker ─────────────────────────────────────────────────────────

describe("POST /fsmworker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(activeFSMLocks).forEach((k) => delete activeFSMLocks[k]);
  });

  it("returns 422 when queue field is missing", async () => {
    const res = await client.fsmworker.$post({
      // @ts-expect-error — intentionally omitting required field
      json: {},
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("queue");
  });

  it("returns 500 with 'Invalid queue id' when the queue is not a known FSM instance", async () => {
    vi.mocked(isFSMInstancePresent).mockResolvedValueOnce(null);

    const res = await client.fsmworker.$post({
      json: { queue: "unknown-instance-id" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Invalid queue id");
  });

  it("returns 500 when a worker for that queue is already in activeFSMLocks", async () => {
    const queueId = "uuid-already-running";
    activeFSMLocks[queueId] = true;

    // isFSMInstancePresent would pass, but lock check should short-circuit
    vi.mocked(isFSMInstancePresent).mockResolvedValueOnce({
      fsm_instance_id: queueId,
      fsm_name: "credit_check",
      fsm_version: "v01",
    } as never);

    const res = await client.fsmworker.$post({
      json: { queue: queueId },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("fsmworker already running");
  });

  it("returns 500 when tryFSMDBLock returns false (lock already held elsewhere)", async () => {
    const queueId = "uuid-lock-taken";
    vi.mocked(isFSMInstancePresent).mockResolvedValueOnce({
      fsm_instance_id: queueId,
      fsm_name: "credit_check",
      fsm_version: "v01",
    } as never);
    vi.mocked(tryFSMDBLock).mockResolvedValueOnce(false);

    const res = await client.fsmworker.$post({
      json: { queue: queueId },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("fsmworker already running");
  });

  it("returns 200 and registers the lock when worker starts successfully", async () => {
    const queueId = "uuid-new-worker";
    const mockFsmInstance = {
      fsm_instance_id: queueId,
      fsm_name: "credit_check",
      fsm_version: "v01",
    };
    vi.mocked(isFSMInstancePresent).mockResolvedValueOnce(
      mockFsmInstance as never,
    );
    vi.mocked(tryFSMDBLock).mockResolvedValueOnce(true);

    const res = await client.fsmworker.$post({
      json: { queue: queueId },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    // Handler returns {} on success
    expect(json).toEqual({});
    // Lock should be registered
    expect(activeFSMLocks[queueId]).toBe(true);
  });

  it("returns 500 with 'Unexpected error' when isFSMInstancePresent throws", async () => {
    vi.mocked(isFSMInstancePresent).mockRejectedValueOnce(
      new Error("DB timeout"),
    );

    const res = await client.fsmworker.$post({
      json: { queue: "some-queue-id" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Unexpected error");
  });
});
