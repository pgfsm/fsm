// SPEC-007 worker side, against a real in-process SidecarGateway over real
// sockets: TCP with TLS + bearer token, mutual TLS, plaintext test mode,
// concurrency (worker-wide and per actor, with precedence), graceful drain,
// and reconnecting after the gateway's max connection age.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ActivityInvokeError,
  SidecarGateway,
  type SidecarListener,
} from "@pgfsm/async-worker-gateway";
import {
  type ActorRegistration,
  ActorWorker,
  type ActorWorkerOptions,
  effectiveMaxConcurrency,
  parseGatewayAddress,
} from "../src/index.ts";
import { makeTestTls, type TestTls } from "./tls_fixture.ts";

const IDENTITY = {
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "internalAsyncOperation",
  asyncOperationVersion: "v01",
  asyncOperationLanguage: "typescript",
};

const invokeOf = (asyncOperationName: string, n = 1) => ({
  ...IDENTITY,
  asyncOperationName,
  input: { n },
  instanceId: `instance-${n}`,
  correlationId: `correlation-${n}`,
});

/** A handler that blocks until released, recording how many run at once. */
function gatedHandler() {
  let running = 0;
  let peak = 0;
  let started = 0;
  const gates: Array<() => void> = [];
  return {
    get running() {
      return running;
    },
    get peak() {
      return peak;
    },
    /** Invokes that have entered the handler so far. */
    get started() {
      return started;
    },
    releaseOne() {
      gates.shift()?.();
    },
    releaseAll() {
      while (gates.length) gates.shift()!();
    },
    handler: async (input: unknown) => {
      started++;
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return { done: (input as { n: number }).n };
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  gateway: SidecarGateway;
  tls: TestTls;
  url: string;
  tokenFile: string;
}

/** A gateway with one TCP listener (TLS unless `plaintext`). */
async function withGateway(
  options: {
    plaintext?: boolean;
    mtls?: boolean;
    token?: boolean;
    maxConnectionAgeMs?: number;
    onActorRegistered?: () => void;
  },
  fn: (h: Harness) => Promise<void>,
) {
  const tls = await makeTestTls();
  const tokenFile = `${tls.dir}/token`;
  await Deno.writeTextFile(tokenFile, "s3cret\n");
  const listener: SidecarListener = {
    kind: "tcp",
    host: "127.0.0.1",
    port: 0,
    ...(options.plaintext ? {} : {
      tls: {
        certFile: tls.certFile,
        keyFile: tls.keyFile,
        ...(options.mtls ? { clientCaFile: tls.caFile } : {}),
      },
    }),
  };
  const gateway = new SidecarGateway({
    listeners: [listener],
    authTokenFile: options.token ? tokenFile : undefined,
    maxConnectionAgeMs: options.maxConnectionAgeMs ?? 0,
    connectionDrainGraceMs: 1_000,
    onActorRegistered: options.onActorRegistered,
    shutdownGraceMs: 200,
  });
  await gateway.start();
  const address = gateway.addresses()[0];
  assert(address.kind === "tcp");
  const host = options.plaintext ? "127.0.0.1" : "localhost";
  const url = `${
    options.plaintext ? "http" : "https"
  }://${host}:${address.port}`;
  try {
    await fn({ gateway, tls, url, tokenFile });
  } finally {
    await gateway.stop();
    await Deno.remove(tls.dir, { recursive: true });
  }
}

/** Runs a worker until `fn` returns, then stops it. */
async function withWorker(
  options: Omit<ActorWorkerOptions, "workerId" | "language">,
  registrations: ActorRegistration[],
  fn: (worker: ActorWorker, running: Promise<void>) => Promise<void>,
) {
  const worker = new ActorWorker(
    {
      workerId: `w-${crypto.randomUUID().slice(0, 8)}`,
      language: "typescript",
      heartbeatMs: 50,
      reconnectInitialDelayMs: 20,
      reconnectMaxDelayMs: 100,
      ...options,
    },
    registrations,
  );
  const running = worker.run();
  try {
    await fn(worker, running);
  } finally {
    await worker.stop();
    await running.catch(() => {});
  }
}

const DOUBLE: ActorRegistration = {
  ...IDENTITY,
  asyncOperationName: "double",
  handler: (input) => ({ doubled: (input as { n: number }).n * 2 }),
};

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "TLS + bearer token: registers over https and serves an invoke",
  ...opts,
  fn: () =>
    withGateway({ token: true }, async ({ gateway, tls, url, tokenFile }) => {
      await withWorker(
        { gatewayAddress: url, caFile: tls.caFile, tokenFile },
        [DOUBLE],
        async () => {
          await waitFor(() => gateway.listRegisteredActors().length === 1);
          const result = await gateway.invoke(invokeOf("double", 21), 5_000);
          assertEquals(result.output, { doubled: 42 });
        },
      );
    }),
});

Deno.test({
  name: "a wrong token fails fast with UNAUTHENTICATED",
  ...opts,
  fn: () =>
    withGateway({ token: true }, async ({ tls, url }) => {
      const badToken = `${tls.dir}/bad-token`;
      await Deno.writeTextFile(badToken, "nope");
      const worker = new ActorWorker(
        {
          workerId: "bad",
          language: "typescript",
          gatewayAddress: url,
          caFile: tls.caFile,
          tokenFile: badToken,
        },
        [DOUBLE],
      );
      await assertRejects(() => worker.run(), Error, "bearer token");
    }),
});

Deno.test({
  name:
    "mutual TLS: a client certificate registers; without one the worker can't connect",
  ...opts,
  fn: () =>
    withGateway({ mtls: true }, async ({ gateway, tls, url }) => {
      await withWorker(
        {
          gatewayAddress: url,
          caFile: tls.caFile,
          certFile: tls.clientCertFile,
          keyFile: tls.clientKeyFile,
        },
        [DOUBLE],
        async () => {
          await waitFor(() => gateway.listRegisteredActors().length === 1);
          const result = await gateway.invoke(invokeOf("double", 2), 5_000);
          assertEquals(result.output, { doubled: 4 });
        },
      );

      const noCert = new ActorWorker(
        {
          workerId: "no-cert",
          language: "typescript",
          gatewayAddress: url,
          caFile: tls.caFile,
          reconnectMaxAttempts: 2,
          reconnectInitialDelayMs: 10,
          reconnectMaxDelayMs: 20,
        },
        [DOUBLE],
      );
      await assertRejects(() => noCert.run(), Error, "giving up");
      assertEquals(gateway.listRegisteredActors(), []);
    }),
});

Deno.test({
  name: "plaintext http:// reaches a gateway in --insecure-plaintext mode",
  ...opts,
  fn: () =>
    withGateway({ plaintext: true }, async ({ gateway, url }) => {
      await withWorker({ gatewayAddress: url }, [DOUBLE], async () => {
        await waitFor(() => gateway.listRegisteredActors().length === 1);
        const result = await gateway.invoke(invokeOf("double", 5), 5_000);
        assertEquals(result.output, { doubled: 10 });
      });
    }),
});

Deno.test({
  name: "invokes run concurrently up to maxConcurrency, and never beyond it",
  ...opts,
  fn: () =>
    withGateway({ plaintext: true }, async ({ gateway, url }) => {
      const gated = gatedHandler();
      await withWorker(
        { gatewayAddress: url, maxConcurrency: 2 },
        [{ ...IDENTITY, asyncOperationName: "slow", handler: gated.handler }],
        async () => {
          await waitFor(() => gateway.listRegisteredActors().length === 1);
          assertEquals(gateway.routingSnapshot()[0].maxConcurrency, 2);

          // Three invokes: two run at once, the third waits for a slot.
          const calls = [1, 2, 3].map((n) =>
            gateway.invoke(invokeOf("slow", n), 10_000)
          );
          await waitFor(() => gated.running === 2);
          await sleep(200);
          assertEquals(gated.running, 2);

          // Finishing one frees its slot: only then does the third start.
          assertEquals(gated.started, 2);
          gated.releaseOne();
          await waitFor(() => gated.started === 3);
          assertEquals(gated.running, 2);
          gated.releaseAll();
          const outputs = await Promise.all(calls);
          assertEquals(outputs.length, 3);
          assertEquals(gated.peak, 2);
        },
      );
    }),
});

Deno.test({
  name:
    "an actor's own maxConcurrency overrides the worker's; unset falls back to it",
  ...opts,
  fn: () =>
    withGateway({ plaintext: true }, async ({ gateway, url }) => {
      const gated = gatedHandler();
      await withWorker(
        { gatewayAddress: url, maxConcurrency: 5 },
        [
          {
            ...IDENTITY,
            asyncOperationName: "capped",
            maxConcurrency: 1,
            handler: gated.handler,
          },
          DOUBLE,
        ],
        async () => {
          await waitFor(() => gateway.listRegisteredActors().length === 2);
          const declared = Object.fromEntries(
            gateway.routingSnapshot().map((
              s,
            ) => [s.identity.asyncOperationName, s.maxConcurrency]),
          );
          assertEquals(declared, { capped: 1, double: 5 });

          // The capped actor runs one at a time even with free worker slots.
          const calls = [1, 2].map((n) =>
            gateway.invoke(invokeOf("capped", n), 10_000)
          );
          await waitFor(() => gated.running === 1);
          await sleep(200);
          assertEquals(gated.running, 1);
          assertEquals(gated.started, 1);
          gated.releaseOne();
          await waitFor(() => gated.started === 2);
          gated.releaseAll();
          await Promise.all(calls);
          assertEquals(gated.peak, 1);
        },
      );
    }),
});

Deno.test({
  name:
    "stop() drains: new invokes are refused as retriable, in-flight ones finish",
  ...opts,
  fn: () =>
    withGateway({ plaintext: true }, async ({ gateway, url }) => {
      const gated = gatedHandler();
      const worker = new ActorWorker(
        {
          workerId: "drainer",
          language: "typescript",
          gatewayAddress: url,
          maxConcurrency: 2,
          shutdownGraceMs: 5_000,
          heartbeatMs: 50,
        },
        [{ ...IDENTITY, asyncOperationName: "slow", handler: gated.handler }],
      );
      const running = worker.run();
      await waitFor(() => gateway.listRegisteredActors().length === 1);

      const inFlight = gateway.invoke(invokeOf("slow", 1), 10_000);
      await waitFor(() => gated.running === 1);

      const stopping = worker.stop();
      // Arrives while draining: refused as retriable, not run.
      const refused = await assertRejects(
        () => gateway.invoke(invokeOf("slow", 2), 10_000),
        ActivityInvokeError,
      );
      assertEquals([refused.code, refused.retriable], [
        "WORKER_DRAINING",
        true,
      ]);
      assertEquals(gated.running, 1);

      // The in-flight invoke still completes and its result arrives.
      gated.releaseAll();
      assertEquals((await inFlight).output, { done: 1 });
      await stopping;
      await running;
      await waitFor(() => gateway.listRegisteredActors().length === 0);
    }),
});

Deno.test({
  name: "the worker reconnects after the gateway's max connection age",
  ...opts,
  fn: async () => {
    let registrations = 0;
    await withGateway(
      {
        plaintext: true,
        maxConnectionAgeMs: 200,
        onActorRegistered: () => registrations++,
      },
      async ({ gateway, url }) => {
        await withWorker({ gatewayAddress: url }, [DOUBLE], async () => {
          await waitFor(() => registrations >= 1);
          // Past 200 ms ± 10 %: drained, disconnected, reconnected.
          await waitFor(() => registrations >= 2, 5_000);
          await waitFor(() => gateway.listRegisteredActors().length === 1);
          const result = await gateway.invoke(invokeOf("double", 4), 5_000);
          assertEquals(result.output, { doubled: 8 });
        });
      },
    );
  },
});

Deno.test("parseGatewayAddress accepts unix:, https:// and http://", () => {
  assertEquals(parseGatewayAddress("unix:/tmp/x.sock"), {
    kind: "unix",
    path: "/tmp/x.sock",
  });
  assertEquals(parseGatewayAddress("https://gw:7443"), {
    kind: "tcp",
    url: "https://gw:7443",
    tls: true,
  });
  assertEquals(parseGatewayAddress("http://127.0.0.1:7443/"), {
    kind: "tcp",
    url: "http://127.0.0.1:7443",
    tls: false,
  });
  for (const bad of ["unix:", "tcp://gw:1", "https://gw", "gw:7443"]) {
    assertThrows(() => parseGatewayAddress(bad), Error, "gateway address");
  }
});

Deno.test("effectiveMaxConcurrency: actor, then worker, then 1", () => {
  assertEquals(effectiveMaxConcurrency(3, 10), 3);
  assertEquals(effectiveMaxConcurrency(undefined, 10), 10);
  assertEquals(effectiveMaxConcurrency(undefined, undefined), 1);
  assertEquals(effectiveMaxConcurrency(0, 0), 1);
});
