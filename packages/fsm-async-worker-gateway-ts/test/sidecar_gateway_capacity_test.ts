// SPEC-007 routing in SidecarGateway: workers declare max_concurrency per
// actor, invokes go to the worker with the most free slots, the poll loop can
// see each actor's free slots, the per-actor routing snapshot tracks
// registration and invoke completion, and TCP sessions are authenticated and
// drained after their max connection age. Drives the private Session handler
// with in-memory streams, like sidecar_gateway_routing_test.ts.

import { assertEquals, assertRejects } from "@std/assert";
import {
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { createHandlerContext } from "@connectrpc/connect";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  type ActivityInvokeInput,
  actorKey,
  SidecarGateway,
} from "../src/sidecar/gateway.ts";

type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

const ACTOR = {
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "internalAsyncOperation",
  asyncOperationName: "checkBureau",
  asyncOperationVersion: "v01",
  asyncOperationLanguage: "python",
};

const KEY = actorKey(
  ACTOR.parentFsmName,
  ACTOR.parentFsmVersion,
  ACTOR.asyncOperationType,
  ACTOR.asyncOperationName,
  ACTOR.asyncOperationVersion,
  ACTOR.asyncOperationLanguage,
);

const INVOKE: ActivityInvokeInput = {
  ...ACTOR,
  input: {},
  instanceId: "instance-1",
  correlationId: "corr-1",
};

class PushStream<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    const next = this.waiting.shift();
    if (next) next({ value: item, done: false });
    else this.buffered.push(item);
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({
            value: this.buffered.shift()!,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

interface FakeWorker {
  invokes: string[];
  reply(invokeId: string): void;
  close(): Promise<void>;
  /** Resolves when the gateway ends this worker's response stream. */
  ended: Promise<void>;
}

type HandleSession = (
  requests: AsyncIterable<SessionRequestMessage>,
  context?: unknown,
  policy?: { kind: "unix" | "tcp" },
) => AsyncIterable<SessionResponseMessage>;

function sessionContext(authorization?: string) {
  return createHandlerContext({
    service: SidecarGatewayService,
    method: SidecarGatewayService.methods.session,
    protocolName: "grpc",
    requestMethod: "POST",
    url:
      "http://localhost/pgfsm.sidecargateway.v1.SidecarGatewayService/Session",
    requestHeader: authorization ? { authorization } : {},
  });
}

async function connectWorker(
  gateway: SidecarGateway,
  workerId: string,
  maxConcurrency: number,
  options: { tcp?: boolean; authorization?: string } = {},
): Promise<FakeWorker> {
  const requests = new PushStream<SessionRequestMessage>();
  requests.push(
    new SessionRequest({
      payload: {
        case: "register",
        value: new Register({
          workerId,
          language: ACTOR.asyncOperationLanguage,
          protocolVersion: "1.0",
          actors: [new RegisteredActor({ ...ACTOR, maxConcurrency })],
        }),
      },
    }),
  );

  const handleSession = (gateway as unknown as { handleSession: HandleSession })
    .handleSession.bind(gateway);
  const responses = handleSession(
    requests,
    options.tcp ? sessionContext(options.authorization) : undefined,
    options.tcp ? { kind: "tcp" } : undefined,
  )[Symbol.asyncIterator]();

  const ack = await responses.next();
  assertEquals(ack.value?.payload.case, "registerAck");

  const invokes: string[] = [];
  const ended = (async () => {
    while (true) {
      const { value, done } = await responses.next();
      if (done) return;
      if (value.payload.case === "invoke") {
        invokes.push(value.payload.value.invokeId);
      }
    }
  })();

  return {
    invokes,
    ended,
    reply(invokeId) {
      requests.push(
        new SessionRequest({
          payload: {
            case: "invokeResult",
            value: new InvokeResult({
              invokeId,
              outputJson: JSON.stringify({ workerId }),
            }),
          },
        }),
      );
    },
    async close() {
      requests.close();
      await ended;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freeSlots(gateway: SidecarGateway): number | undefined {
  return gateway.listClaimableActors().find((a) =>
    actorKey(
      a.identity.parentFsmName,
      a.identity.parentFsmVersion,
      a.identity.asyncOperationType,
      a.identity.asyncOperationName,
      a.identity.asyncOperationVersion,
      a.identity.asyncOperationLanguage,
    ) === KEY
  )?.freeSlots;
}

Deno.test("invokes go to the worker with the most free slots, and free slots track them", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const a = await connectWorker(gateway, "a", 2);
  const b = await connectWorker(gateway, "b", 1);
  assertEquals(freeSlots(gateway), 3);

  // a has 2 free, b 1: first to a; then a and b have 1 each (either);
  // the third goes to whichever is still free.
  const calls = [
    gateway.invoke(INVOKE, 1_000),
    gateway.invoke(INVOKE, 1_000),
    gateway.invoke(INVOKE, 1_000),
  ];
  await tick();
  assertEquals(a.invokes.length, 2);
  assertEquals(b.invokes.length, 1);
  assertEquals(freeSlots(gateway), 0);

  a.reply(a.invokes[0]);
  await calls[0];
  assertEquals(freeSlots(gateway), 1);

  a.reply(a.invokes[1]);
  b.reply(b.invokes[0]);
  await Promise.all(calls);
  assertEquals(freeSlots(gateway), 3);

  await a.close();
  await b.close();
});

Deno.test("max_concurrency 0 (an older SDK) counts as 1", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const a = await connectWorker(gateway, "a", 0);
  assertEquals(freeSlots(gateway), 1);
  await a.close();
});

Deno.test("routing snapshot tracks registration, in-flight invokes and completion", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  assertEquals(gateway.routingSnapshot(), []);

  const a = await connectWorker(gateway, "a", 2);
  const b = await connectWorker(gateway, "b", 3);
  const [snapshot] = gateway.routingSnapshot();
  assertEquals(snapshot.actorKey, KEY);
  assertEquals(snapshot.identity, ACTOR);
  assertEquals(
    [snapshot.liveWorkers, snapshot.maxConcurrency, snapshot.inFlight],
    [2, 5, 0],
  );

  const call = gateway.invoke(INVOKE, 1_000);
  await tick();
  assertEquals(gateway.routingSnapshot()[0].inFlight, 1);

  const worker = a.invokes.length ? a : b;
  worker.reply(worker.invokes[0]);
  await call;
  assertEquals(gateway.routingSnapshot()[0].inFlight, 0);

  await a.close();
  assertEquals(
    [
      gateway.routingSnapshot()[0].liveWorkers,
      gateway.routingSnapshot()[0].maxConcurrency,
    ],
    [1, 3],
  );
  await b.close();
  assertEquals(gateway.routingSnapshot(), []);
});

Deno.test("a missing route is a retriable ACTOR_NOT_FOUND (#396)", async () => {
  const gateway = new SidecarGateway({ socketPath: "/unused" });
  const error = await assertRejects(() => gateway.invoke(INVOKE, 1_000));
  assertEquals(
    [
      (error as { code: string }).code,
      (error as { retriable: boolean }).retriable,
    ],
    ["ACTOR_NOT_FOUND", true],
  );
});

Deno.test("TCP sessions need the bearer token, re-read from its file each time", async () => {
  const tokenFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tokenFile, "first-token\n");
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    authTokenFile: tokenFile,
    maxConnectionAgeMs: 0,
  });
  try {
    for (const authorization of [undefined, "Bearer wrong", "first-token"]) {
      await assertRejects(
        () => connectWorker(gateway, "x", 1, { tcp: true, authorization }),
        Error,
        "missing or invalid bearer token",
      );
    }
    const ok = await connectWorker(gateway, "a", 1, {
      tcp: true,
      authorization: "Bearer first-token",
    });
    await ok.close();

    // Rotation: the new token works and the old one doesn't, no restart.
    await Deno.writeTextFile(tokenFile, "second-token");
    await assertRejects(
      () =>
        connectWorker(gateway, "b", 1, {
          tcp: true,
          authorization: "Bearer first-token",
        }),
      Error,
      "missing or invalid bearer token",
    );
    const rotated = await connectWorker(gateway, "b", 1, {
      tcp: true,
      authorization: "Bearer second-token",
    });
    await rotated.close();

    // Unix-socket sessions aren't checked.
    const unix = await connectWorker(gateway, "c", 1);
    await unix.close();
  } finally {
    await Deno.remove(tokenFile);
  }
});

// Several accepted tokens (#429).

/** Connects a TCP worker with `Bearer <token>`; resolves true if accepted. */
async function acceptsToken(
  gateway: SidecarGateway,
  workerId: string,
  token: string,
): Promise<boolean> {
  try {
    const worker = await connectWorker(gateway, workerId, 1, {
      tcp: true,
      authorization: `Bearer ${token}`,
    });
    await worker.close();
    return true;
  } catch (error) {
    if (String(error).includes("missing or invalid bearer token")) return false;
    throw error;
  }
}

/** The name of the token `authorization` matches, without registering a worker. */
function tokenNameFor(gateway: SidecarGateway, authorization: string) {
  return (gateway as unknown as {
    authorize(context: { requestHeader: Headers }): string | undefined;
  }).authorize({ requestHeader: new Headers({ authorization }) });
}

Deno.test("TCP sessions accept any of several token files, and nothing else", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/python`, "py-token\n");
    await Deno.writeTextFile(`${dir}/go`, "go-token");
    const gateway = new SidecarGateway({
      socketPath: "/unused",
      authTokenFiles: [`${dir}/python`, `${dir}/go`],
      maxConnectionAgeMs: 0,
    });
    assertEquals(await acceptsToken(gateway, "a", "py-token"), true);
    assertEquals(await acceptsToken(gateway, "b", "go-token"), true);
    assertEquals(await acceptsToken(gateway, "c", "rust-token"), false);
    // The name logged is the file's, never the value.
    assertEquals(tokenNameFor(gateway, "Bearer go-token"), "go");
    assertEquals(tokenNameFor(gateway, "Bearer nope"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a token directory rotates with overlap: add the new token, switch, remove the old, no refused reconnect", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/token-v1`, "old");
    const gateway = new SidecarGateway({
      socketPath: "/unused",
      authTokenDir: dir,
      maxConnectionAgeMs: 0,
    });
    assertEquals(await acceptsToken(gateway, "w", "old"), true);
    assertEquals(await acceptsToken(gateway, "w", "new"), false);

    // 1. Add the new token: both work, so workers can switch one by one.
    await Deno.writeTextFile(`${dir}/token-v2`, "new");
    assertEquals(await acceptsToken(gateway, "w", "old"), true);
    assertEquals(await acceptsToken(gateway, "w", "new"), true);

    // 2. Remove the old one once every worker uses the new token.
    await Deno.remove(`${dir}/token-v1`);
    assertEquals(await acceptsToken(gateway, "w", "new"), true);
    assertEquals(await acceptsToken(gateway, "w", "old"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a Kubernetes Secret volume works as the token directory: one key per language, hidden entries skipped", async () => {
  // What kubelet mounts for a Secret with keys `python` and `go`:
  //   ..2026_10_04_10_00_00.000000000/{python,go}   (the real files)
  //   ..data -> ..2026_10_04_10_00_00.000000000
  //   python -> ..data/python, go -> ..data/go
  const dir = await Deno.makeTempDir();
  try {
    const stamp = "..2026_10_04_10_00_00.000000000";
    await Deno.mkdir(`${dir}/${stamp}`);
    await Deno.writeTextFile(`${dir}/${stamp}/python`, "py-token\n");
    await Deno.writeTextFile(`${dir}/${stamp}/go`, "go-token\n");
    await Deno.symlink(stamp, `${dir}/..data`);
    await Deno.symlink("..data/python", `${dir}/python`);
    await Deno.symlink("..data/go", `${dir}/go`);
    const gateway = new SidecarGateway({
      socketPath: "/unused",
      authTokenDir: dir,
      maxConnectionAgeMs: 0,
    });
    assertEquals(await acceptsToken(gateway, "py", "py-token"), true);
    assertEquals(await acceptsToken(gateway, "go", "go-token"), true);
    assertEquals(tokenNameFor(gateway, "Bearer py-token"), "python");
    assertEquals(await acceptsToken(gateway, "x", "other"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("empty or missing token sources are skipped; with none left, every TCP session is refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/empty`, "  \n");
    await Deno.writeTextFile(`${dir}/good`, "good-token");
    const gateway = new SidecarGateway({
      socketPath: "/unused",
      authTokenFiles: [`${dir}/missing`, `${dir}/empty`, `${dir}/good`],
      maxConnectionAgeMs: 0,
    });
    assertEquals(await acceptsToken(gateway, "a", "good-token"), true);
    // An empty file never makes an empty token valid.
    assertEquals(await acceptsToken(gateway, "b", ""), false);

    await Deno.remove(`${dir}/good`);
    assertEquals(await acceptsToken(gateway, "c", "good-token"), false);

    // A configured but unreadable directory fails closed too.
    const noDir = new SidecarGateway({
      socketPath: "/unused",
      authTokenDir: `${dir}/no-such-dir`,
      maxConnectionAgeMs: 0,
    });
    assertEquals(await acceptsToken(noDir, "d", "good-token"), false);
    // Unix-socket sessions stay unchecked.
    const unix = await connectWorker(noDir, "e", 1);
    await unix.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a TCP worker past its max connection age is drained, then disconnected", async () => {
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    maxConnectionAgeMs: 50,
    connectionDrainGraceMs: 5_000,
  });
  const a = await connectWorker(gateway, "a", 2, { tcp: true });
  const inFlight = gateway.invoke(INVOKE, 5_000);
  await tick();
  assertEquals(a.invokes.length, 1);

  await sleep(80); // past 50 ms ± 10 %
  // Draining: no capacity, no new invokes, but still connected.
  assertEquals(freeSlots(gateway), 0);
  await assertRejects(
    () => gateway.invoke(INVOKE, 1_000),
    Error,
    "worker unavailable",
  );
  assertEquals(gateway.routingSnapshot()[0].liveWorkers, 1);

  // The in-flight invoke finishes, then the gateway ends the stream.
  a.reply(a.invokes[0]);
  await inFlight;
  await a.ended;
  assertEquals(gateway.listRegisteredActors(), []);
});

Deno.test("Unix-socket workers never hit the max connection age", async () => {
  const gateway = new SidecarGateway({
    socketPath: "/unused",
    maxConnectionAgeMs: 20,
  });
  const a = await connectWorker(gateway, "a", 1);
  await sleep(60);
  assertEquals(freeSlots(gateway), 1);
  await a.close();
});
