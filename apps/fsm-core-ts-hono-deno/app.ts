// apps/host/app.ts
import { Hono } from "hono";
import createApp from "../fsm-core-ts-hono-deno/lib/create-app.ts";

const urlPathPrefix = "/api/v1";

// The API serves HTTP only; run fsmlets as separate workers (a generated
// worker project's sync-worker, or the reference K8s manifests).
const fsmRouter = await createApp(urlPathPrefix);

const host = new Hono();
host.route(urlPathPrefix, fsmRouter);

export default host;
