import { assertEquals } from "@std/assert";
import { type ActorRegistration, runActorWorkerCli } from "../src/index.ts";

const REGISTRATIONS: ActorRegistration[] = [
  {
    parentFsmName: "creditCheck",
    parentFsmVersion: "v01",
    asyncOperationType: "fsm",
    asyncOperationName: "checkBureau",
    asyncOperationVersion: "v01",
    asyncOperationLanguage: "typescript",
    handler: () => null,
  },
];

Deno.test("runActorWorkerCli - --help exits 0", async () => {
  assertEquals(
    await runActorWorkerCli({ registrations: REGISTRATIONS, args: ["--help"] }),
    0,
  );
});

Deno.test("runActorWorkerCli - list exits 0 without connecting", async () => {
  assertEquals(
    await runActorWorkerCli({
      registrations: REGISTRATIONS,
      args: ["list", "--gateway-socket", "/nonexistent.sock"],
    }),
    0,
  );
});

Deno.test("runActorWorkerCli - missing or unknown command exits 1", async () => {
  assertEquals(
    await runActorWorkerCli({ registrations: REGISTRATIONS, args: [] }),
    1,
  );
  assertEquals(
    await runActorWorkerCli({ registrations: REGISTRATIONS, args: ["serve"] }),
    1,
  );
});

Deno.test("runActorWorkerCli - start with an empty registry exits 1", async () => {
  assertEquals(
    await runActorWorkerCli({ registrations: [], args: ["start"] }),
    1,
  );
});

Deno.test({
  name: "runActorWorkerCli - start exits 1 after --reconnect-max-attempts",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertEquals(
      await runActorWorkerCli({
        registrations: REGISTRATIONS,
        args: [
          "start",
          "--gateway-socket",
          "/nonexistent/sidecar.sock",
          "--reconnect-initial-delay-ms",
          "5",
          "--reconnect-max-attempts",
          "2",
        ],
      }),
      1,
    );
  },
});

Deno.test("runActorWorkerCli - start rejects bad transport and concurrency flags before connecting", async () => {
  const dir = await Deno.makeTempDir();
  const token = `${dir}/token`;
  await Deno.writeTextFile(token, "t");
  try {
    for (
      const args of [
        // both ways of naming the gateway
        [
          "--gateway-socket",
          "/tmp/x.sock",
          "--gateway-address",
          "unix:/tmp/y.sock",
        ],
        // not unix:/https:/http:
        ["--gateway-address", "tcp://gw:7443"],
        // a client certificate without its key
        ["--gateway-address", "https://gw:7443", "--gateway-cert-file", token],
        // credentials that don't exist
        [
          "--gateway-address",
          "https://gw:7443",
          "--gateway-token-file",
          `${dir}/missing`,
        ],
        [
          "--gateway-address",
          "https://gw:7443",
          "--gateway-ca-file",
          `${dir}/missing`,
        ],
        // invalid numbers
        ["--max-concurrency", "0"],
        ["--max-concurrency", "two"],
        ["--keepalive-timeout-ms", "0"],
        ["--shutdown-grace-ms", "-1"],
      ]
    ) {
      const code = await runActorWorkerCli({
        registrations: REGISTRATIONS,
        args: ["start", ...args],
      });
      assertEquals(code, 1, args.join(" "));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
