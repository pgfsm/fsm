/* eslint-disable ts/ban-ts-comment */
/**
 * Tests for /fsmpromise routes.
 * Requires vitest (add to deno.json imports: "vitest": "npm:vitest@^2")
 * and NODE_ENV=test in .env.
 *
 * Mocked dependencies:
 *   - @fsm/db (pgmqQueueExists)
 *   - fsm-core-worker-ts/src/index (startFSMPromiseWorker)
 *   - middlewares/supabase (getSupabase)
 *
 * Note on handler behaviour:
 *   - When PGMQ queue is missing → returns 200 with { error: "PGMQ queue does not exist" }
 *     (not 404/500 — intentional design choice in the handler).
 *   - When queue exists → returns 200 with success message and starts worker async.
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

vi.mock("@fsm/db", () => ({
  pgmqQueueExists: vi.fn(),
}));

vi.mock("../../../fsm-core-worker-ts/src/index.ts", () => ({
  startFSMPromiseWorker: vi.fn().mockResolvedValue(undefined),
}));

import { pgmqQueueExists } from "@fsm/db";
import { startFSMPromiseWorker } from "../../../fsm-core-worker-ts/src/index.ts";
import { createRouter } from "../../lib/create-app.ts";
import { activePromiseLocks } from "./fsmpromise.handlers.ts";
import router from "./fsmpromise.index.ts";

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

// ─── GET /fsmpromise ─────────────────────────────────────────────────────────

describe("GET /fsmpromise", () => {
  beforeEach(() => {
    Object.keys(activePromiseLocks).forEach((k) => delete activePromiseLocks[k]);
  });

  it("returns 200 with an empty data object when no promise workers are active", async () => {
    const res = await client.fsmpromise.$get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
    expect(json.data).toEqual({});
  });
});

// ─── POST /fsmpromise ────────────────────────────────────────────────────────

describe("POST /fsmpromise", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(activePromiseLocks).forEach((k) => delete activePromiseLocks[k]);
  });

  it("returns 422 when promise_name is missing", async () => {
    const res = await client.fsmpromise.$post({
      // @ts-expect-error — intentionally omitting required field
      json: { promise_version: "v01" },
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("promise_name");
  });

  it("returns 422 when promise_version is missing", async () => {
    const res = await client.fsmpromise.$post({
      // @ts-expect-error — intentionally omitting required field
      json: { promise_name: "credit_promise" },
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.issues[0].path[0]).toBe("promise_version");
  });

  it("returns 422 when body is empty", async () => {
    const res = await client.fsmpromise.$post({
      // @ts-expect-error
      json: {},
    });
    expect(res.status).toBe(422);
  });

  it("returns 200 with error message when PGMQ queue does not exist (handler design)", async () => {
    // Note: handler intentionally returns HTTP 200 even when the queue is missing.
    vi.mocked(pgmqQueueExists).mockResolvedValueOnce(false);

    const res = await client.fsmpromise.$post({
      json: { promise_name: "credit_promise", promise_version: "v01" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.error).toBe("PGMQ queue does not exist");
  });

  it("does not start a worker when PGMQ queue does not exist", async () => {
    vi.mocked(pgmqQueueExists).mockResolvedValueOnce(false);

    await client.fsmpromise.$post({
      json: { promise_name: "credit_promise", promise_version: "v01" },
    });
    expect(startFSMPromiseWorker).not.toHaveBeenCalled();
  });

  it("returns 200 with success data and starts worker when queue exists", async () => {
    vi.mocked(pgmqQueueExists).mockResolvedValueOnce(true);

    const res = await client.fsmpromise.$post({
      json: { promise_name: "credit_promise", promise_version: "v01" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toContain("credit_promise");
    expect(startFSMPromiseWorker).toHaveBeenCalledWith(
      expect.any(Object),      // deps
      "credit_promise",
      "credit_promise",
      "v01",
    );
  });

  it("returns 500 with 'Unexpected error' when pgmqQueueExists throws", async () => {
    vi.mocked(pgmqQueueExists).mockRejectedValueOnce(new Error("DB error"));

    const res = await client.fsmpromise.$post({
      json: { promise_name: "credit_promise", promise_version: "v01" },
    });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Unexpected error");
  });
});
