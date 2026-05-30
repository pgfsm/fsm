/* eslint-disable ts/ban-ts-comment */
/**
 * Tests for /fsm routes (list, create, send, currentActive, start, stop).
 * Requires vitest (add to deno.json imports: "vitest": "npm:vitest@^2")
 * and NODE_ENV=test in .env.
 *
 * Mocked dependencies:
 *   - @fsm/db (createFsmInstanceFromName, sendEventToFsmQueueWithEventLogs,
 *              getFsmDataResolveStateValue, listFsmInstances, getFSMData)
 *   - @fsm/worker (startFSMWorkerWithDBLock, createAndStartFSMWorker)
 *   - middlewares/supabase (getSupabase)
 *   - activeWorkers — shared module-level state (single source of truth for running workers)
 */
import { testClient } from "hono/testing";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Module-level mocks must be declared before any imports that trigger them.
vi.mock("../../middlewares/supabase.ts", () => ({
  getSupabase: vi.fn(() => null),
  supabaseMiddleware: vi.fn(() => (_c: unknown, next: () => void) => next()),
}));

vi.mock("@fsm/db", () => ({
  createFsmInstanceFromName: vi.fn(),
  sendEventToFsmQueueWithEventLogs: vi.fn(),
  getFsmDataResolveStateValue: vi.fn(),
  listFsmInstances: vi.fn(),
  getFSMData: vi.fn(),
  API_SYSTEM_QUEUE_UUID: "system-uuid",
  API_SYSTEM_QUEUE_TYPE: "system",
  API_SYSTEM_EVENT_NAME: "system-event",
}));

vi.mock("@fsm/worker", () => ({
  startFSMWorkerWithDBLock: vi.fn().mockResolvedValue(true),
  createAndStartFSMWorker: vi.fn(),
}));

import { createFsmInstanceFromName, sendEventToFsmQueueWithEventLogs, getFsmDataResolveStateValue } from "@fsm/db";
import { startFSMWorkerWithDBLock } from "@fsm/worker";
import { createRouter } from "../../lib/create-app.ts";
import { activeWorkers } from "./fsm.handlers.ts";
import router from "./fsm.index.ts";

/** Minimal Hono app that injects a mock db into context. */
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

// ─── GET /fsm ────────────────────────────────────────────────────────────────

import { listFsmInstances } from "@fsm/db";

describe("GET /fsm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with empty data when no instances exist", async () => {
    vi.mocked(listFsmInstances).mockResolvedValueOnce([]);
    const res = await client.fsm.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
    expect(json.data).toEqual([]);
  });

  it("returns 200 with the list of FSM instances", async () => {
    const mockInstances = [
      { id: "uuid-1", fsm_name: "credit_check", fsm_version: "v01", fsm_instance_status: "active" },
    ];
    vi.mocked(listFsmInstances).mockResolvedValueOnce(mockInstances as never);
    const res = await client.fsm.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual(mockInstances);
  });
});

// ─── POST /fsm ───────────────────────────────────────────────────────────────

describe("POST /fsm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 422 when fsm_name is missing", async () => {
    const res = await client.fsm.$post({
      // @ts-expect-error — intentionally omitting required field
      json: { fsm_version: "v01" },
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("fsm_name");
  });

  it("returns 422 when fsm_version is missing", async () => {
    const res = await client.fsm.$post({
      // @ts-expect-error — intentionally omitting required field
      json: { fsm_name: "credit_check" },
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("fsm_version");
  });

  it("returns 422 when body is empty", async () => {
    const res = await client.fsm.$post({
      // @ts-expect-error
      json: {},
    });
    expect(res.status).toBe(422);
  });

  it("returns 200 with fsm instance data on successful creation", async () => {
    const mockInstance = {
      fsm_instance_id: "uuid-abc-123",
      fsm_name: "credit_check",
      fsm_version: "v01",
    };
    vi.mocked(createFsmInstanceFromName).mockResolvedValueOnce(mockInstance);
    vi.mocked(startFSMWorkerWithDBLock).mockResolvedValueOnce(true);

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject(mockInstance);
  });

  it("returns 500 when createFsmInstanceFromName returns null (creation failed)", async () => {
    vi.mocked(createFsmInstanceFromName).mockResolvedValueOnce(null);

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toHaveProperty("error", "fsm instance creation failed");
  });

  it("returns 500 when createFsmInstanceFromName returns an object without fsm_instance_id", async () => {
    vi.mocked(createFsmInstanceFromName).mockResolvedValueOnce({} as never);

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("returns 500 with 'Unexpected error' when an exception is thrown", async () => {
    vi.mocked(createFsmInstanceFromName).mockRejectedValueOnce(
      new Error("DB connection failed"),
    );

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Unexpected error");
  });

  it("does not register a controller when lock acquisition fails", async () => {
    const mockInstance = { fsm_instance_id: "uuid-lock-fail", fsm_version: "v01" };
    vi.mocked(createFsmInstanceFromName).mockResolvedValueOnce(mockInstance);
    vi.mocked(startFSMWorkerWithDBLock).mockResolvedValueOnce(false);

    await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(activeWorkers["uuid-lock-fail"]).toBeUndefined();
  });
});

// ─── POST /fsm/send ──────────────────────────────────────────────────────────

describe("POST /fsm/send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 422 when fsm_instance_id is missing", async () => {
    const res = await client.fsm.send.$post({
      // @ts-expect-error
      json: { event_data: { type: "START" } },
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("fsm_instance_id");
  });

  it("returns 422 when event_data is missing", async () => {
    const res = await client.fsm.send.$post({
      // @ts-expect-error
      json: { fsm_instance_id: "uuid-abc-123" },
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("event_data");
  });

  it("returns 422 when event_data.type is missing", async () => {
    const res = await client.fsm.send.$post({
      // @ts-expect-error
      json: { fsm_instance_id: "uuid-abc-123", event_data: {} },
    });
    expect(res.status).toBe(422);
  });

  it("returns 200 with data on successful event send", async () => {
    const mockResult = { msg_id: "42" };
    vi.mocked(sendEventToFsmQueueWithEventLogs).mockResolvedValueOnce(mockResult);

    const res = await client.fsm.send.$post({
      json: {
        fsm_instance_id: "uuid-abc-123",
        event_data: { type: "START" },
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject(mockResult);
  });

  it("accepts extra fields in event_data (passthrough schema)", async () => {
    vi.mocked(sendEventToFsmQueueWithEventLogs).mockResolvedValueOnce({ msg_id: "1" });

    const res = await client.fsm.send.$post({
      json: {
        fsm_instance_id: "uuid-abc-123",
        event_data: { type: "APPROVE", payload: { amount: 5000 }, source: "api" },
      },
    });
    expect(res.status).toBe(200);
  });

  it("returns 500 with 'Unexpected error' when sendEventToFsmQueueWithEventLogs throws", async () => {
    vi.mocked(sendEventToFsmQueueWithEventLogs).mockRejectedValueOnce(new Error("queue error"));

    const res = await client.fsm.send.$post({
      json: {
        fsm_instance_id: "uuid-abc-123",
        event_data: { type: "START" },
      },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Unexpected error");
  });
});

// ─── GET /fsm/currentActive ───────────────────────────────────────────────────

describe("GET /fsm/currentActive", () => {
  beforeEach(() => {
    Object.keys(activeWorkers).forEach((k) => delete activeWorkers[k]);
  });

  it("returns 200 with an empty data object when no workers are active", async () => {
    const res = await client.fsm.currentActive.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
    expect(json.data).toEqual({});
  });

  it("reflects workers registered in activeWorkers", async () => {
    activeWorkers["some-queue-id"] = { lock: true, controller: new AbortController() };
    const res = await client.fsm.currentActive.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveProperty("some-queue-id", true);
  });
});

// ─── POST /fsm/start ─────────────────────────────────────────────────────────

describe("POST /fsm/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(activeWorkers).forEach((k) => delete activeWorkers[k]);
  });

  it("returns 422 when queue field is missing", async () => {
    const res = await client.fsm.start.$post({
      // @ts-expect-error — intentionally omitting required field
      json: {},
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("queue");
  });

  it("returns 500 with 'Invalid queue id' when the queue is not a known FSM instance", async () => {
    vi.mocked(getFsmDataResolveStateValue).mockResolvedValueOnce(null);

    const res = await client.fsm.start.$post({
      json: { queue: "unknown-instance-id" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("Invalid queue id");
  });

  it("returns 500 when a worker for that queue is already in activeWorkers", async () => {
    const queueId = "uuid-already-running";
    activeWorkers[queueId] = { lock: true, controller: new AbortController() };

    vi.mocked(getFsmDataResolveStateValue).mockResolvedValueOnce({
      fsm_instance_row: {
        fsm_instance_id: queueId,
        fsm_name: "credit_check",
        fsm_version: "v01",
      },
    } as never);

    const res = await client.fsm.start.$post({
      json: { queue: queueId },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("fsmworker already running");
  });

  it("returns 500 when tryFSMDBLock returns false (lock already held elsewhere)", async () => {
    const queueId = "uuid-lock-taken";
    vi.mocked(getFsmDataResolveStateValue).mockResolvedValueOnce({
      fsm_instance_row: {
        fsm_instance_id: queueId,
        fsm_name: "credit_check",
        fsm_version: "v01",
      },
    } as never);
    vi.mocked(startFSMWorkerWithDBLock).mockResolvedValueOnce(false);

    const res = await client.fsm.start.$post({
      json: { queue: queueId },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("fsmworker already running");
  });

  it("returns 200 when worker starts successfully", async () => {
    const queueId = "uuid-new-worker";
    vi.mocked(getFsmDataResolveStateValue).mockResolvedValueOnce({
      fsm_instance_row: {
        fsm_instance_id: queueId,
        fsm_name: "credit_check",
        fsm_version: "v01",
      },
    } as never);
    vi.mocked(startFSMWorkerWithDBLock).mockResolvedValueOnce(true);

    const res = await client.fsm.start.$post({
      json: { queue: queueId },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({});
  });

  it("returns 500 with 'Unexpected error' when getFsmDataResolveStateValue throws", async () => {
    vi.mocked(getFsmDataResolveStateValue).mockRejectedValueOnce(
      new Error("DB timeout"),
    );

    const res = await client.fsm.start.$post({
      json: { queue: "some-queue-id" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Unexpected error");
  });
});

// ─── POST /fsm/stop ──────────────────────────────────────────────────────────

describe("POST /fsm/stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(activeWorkers).forEach((k) => delete activeWorkers[k]);
  });

  it("returns 404 when no worker is active for the given queue", async () => {
    const res = await client.fsm.stop.$post({
      json: { queue: "non-existent-queue" },
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("No active worker");
  });

  it("returns 200 and marks lock=false when a worker is active", async () => {
    const queueId = "uuid-running-worker";
    const controller = new AbortController();
    activeWorkers[queueId] = { lock: true, controller };

    const res = await client.fsm.stop.$post({
      json: { queue: queueId },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({});
    expect(controller.signal.aborted).toBe(true);
    // entry stays until onStop fires (async); lock flips to false immediately
    expect(activeWorkers[queueId]).toBeDefined();
    expect(activeWorkers[queueId].lock).toBe(false);
  });

  it("returns 200 on a second stop call (entry stays until onStop fires)", async () => {
    const queueId = "uuid-stopped-twice";
    activeWorkers[queueId] = { lock: true, controller: new AbortController() };

    await client.fsm.stop.$post({ json: { queue: queueId } });

    // entry is still present (onStop is async); second call is a no-op but succeeds
    const res = await client.fsm.stop.$post({ json: { queue: queueId } });
    expect(res.status).toBe(200);
  });
});
