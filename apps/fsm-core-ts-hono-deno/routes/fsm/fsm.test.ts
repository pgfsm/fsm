/* eslint-disable ts/ban-ts-comment */
/**
 * Tests for /fsm routes.
 * Requires vitest (add to deno.json imports: "vitest": "npm:vitest@^2")
 * and NODE_ENV=test in .env.
 *
 * Mocked dependencies:
 *   - @fsm/db (createFSMInstanceFromName, sendFSMEvent)
 *   - @fsm/worker (startFSMWorkerWithDBLock)
 *   - middlewares/supabase (getSupabase)
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
  createFSMInstanceFromName: vi.fn(),
  sendFSMEvent: vi.fn(),
}));

vi.mock("@fsm/worker", () => ({
  startFSMWorkerWithDBLock: vi.fn().mockResolvedValue(true),
}));

import { createFSMInstanceFromName, sendFSMEvent } from "@fsm/db";
import { startFSMWorkerWithDBLock } from "@fsm/worker";
import { createRouter } from "../../lib/create-app.ts";
import { activeFSMLocks } from "./fsm.handlers.ts";
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

describe("GET /fsm", () => {
  beforeEach(() => {
    // Reset shared lock state before each test.
    Object.keys(activeFSMLocks).forEach((k) => delete activeFSMLocks[k]);
  });

  it("returns 200 with an empty data object when no workers are active", async () => {
    const res = await client.fsm.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
    expect(json.data).toEqual({});
  });

  it("reflects active locks that were added externally", async () => {
    activeFSMLocks["test-instance-id"] = true;
    const res = await client.fsm.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveProperty("test-instance-id", true);
  });
});

// ─── POST /fsm ───────────────────────────────────────────────────────────────

describe("POST /fsm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(activeFSMLocks).forEach((k) => delete activeFSMLocks[k]);
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
    vi.mocked(createFSMInstanceFromName).mockResolvedValueOnce(mockInstance);
    vi.mocked(startFSMWorkerWithDBLock).mockResolvedValueOnce(true);

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject(mockInstance);
  });

  it("returns 500 when createFSMInstanceFromName returns null (creation failed)", async () => {
    vi.mocked(createFSMInstanceFromName).mockResolvedValueOnce(null);

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toHaveProperty("error", "fsm instance creation failed");
  });

  it("returns 500 when createFSMInstanceFromName returns an object without fsm_instance_id", async () => {
    vi.mocked(createFSMInstanceFromName).mockResolvedValueOnce({} as never);

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("returns 500 with 'Unexpected error' when an exception is thrown", async () => {
    vi.mocked(createFSMInstanceFromName).mockRejectedValueOnce(
      new Error("DB connection failed"),
    );

    const res = await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Unexpected error");
  });

  it("does not add to activeFSMLocks when lock acquisition fails", async () => {
    const mockInstance = { fsm_instance_id: "uuid-lock-fail", fsm_version: "v01" };
    vi.mocked(createFSMInstanceFromName).mockResolvedValueOnce(mockInstance);
    vi.mocked(startFSMWorkerWithDBLock).mockResolvedValueOnce(false);

    await client.fsm.$post({
      json: { fsm_name: "credit_check", fsm_version: "v01" },
    });
    // Worker should NOT be registered in active locks when lock fails
    expect(activeFSMLocks["uuid-lock-fail"]).toBeUndefined();
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
    vi.mocked(sendFSMEvent).mockResolvedValueOnce(mockResult);

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
    vi.mocked(sendFSMEvent).mockResolvedValueOnce({ msg_id: "1" });

    const res = await client.fsm.send.$post({
      json: {
        fsm_instance_id: "uuid-abc-123",
        event_data: { type: "APPROVE", payload: { amount: 5000 }, source: "api" },
      },
    });
    expect(res.status).toBe(200);
  });

  it("returns 500 with 'Unexpected error' when sendFSMEvent throws", async () => {
    vi.mocked(sendFSMEvent).mockRejectedValueOnce(new Error("queue error"));

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
