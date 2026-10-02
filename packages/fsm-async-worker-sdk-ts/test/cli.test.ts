import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ActorRegistration,
  ENV_OPTIONS,
  envVarFor,
  resolveSettings,
  runActorWorkerCli,
} from "../src/index.ts";

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

// Environment-variable fallbacks (#438): every option falls back to
// PGFSM_<LONG_NAME>; a flag wins over its variable; an empty variable counts
// as unset; invalid values are named by their variable.

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test("envVarFor names every option's variable the same way in all SDKs", () => {
  assertEquals(envVarFor("gateway-address"), "PGFSM_GATEWAY_ADDRESS");
  assertEquals(
    ENV_OPTIONS.map(envVarFor),
    [
      "PGFSM_GATEWAY_SOCKET",
      "PGFSM_GATEWAY_ADDRESS",
      "PGFSM_GATEWAY_CA_FILE",
      "PGFSM_GATEWAY_TOKEN_FILE",
      "PGFSM_GATEWAY_CERT_FILE",
      "PGFSM_GATEWAY_KEY_FILE",
      "PGFSM_MAX_CONCURRENCY",
      "PGFSM_KEEPALIVE_INTERVAL_MS",
      "PGFSM_KEEPALIVE_TIMEOUT_MS",
      "PGFSM_SHUTDOWN_GRACE_MS",
      "PGFSM_WORKER_ID",
      "PGFSM_HEARTBEAT_MS",
      "PGFSM_RECONNECT_INITIAL_DELAY_MS",
      "PGFSM_RECONNECT_MAX_DELAY_MS",
      "PGFSM_RECONNECT_MAX_ATTEMPTS",
    ],
  );
});

Deno.test("resolveSettings: every option comes from its variable when the flag is absent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const f of ["ca", "token", "cert", "key"]) {
      await Deno.writeTextFile(`${dir}/${f}`, "x");
    }
    const settings = resolveSettings(
      {},
      envOf({
        PGFSM_GATEWAY_ADDRESS: "https://gw:7443",
        PGFSM_GATEWAY_CA_FILE: `${dir}/ca`,
        PGFSM_GATEWAY_TOKEN_FILE: `${dir}/token`,
        PGFSM_GATEWAY_CERT_FILE: `${dir}/cert`,
        PGFSM_GATEWAY_KEY_FILE: `${dir}/key`,
        PGFSM_MAX_CONCURRENCY: "10",
        PGFSM_KEEPALIVE_INTERVAL_MS: "0",
        PGFSM_KEEPALIVE_TIMEOUT_MS: "500",
        PGFSM_SHUTDOWN_GRACE_MS: "1000",
        PGFSM_WORKER_ID: "w-env",
        PGFSM_HEARTBEAT_MS: "250",
        PGFSM_RECONNECT_INITIAL_DELAY_MS: "5",
        PGFSM_RECONNECT_MAX_DELAY_MS: "100",
        PGFSM_RECONNECT_MAX_ATTEMPTS: "3",
      }),
    );
    assertEquals(settings, {
      gatewayAddress: "https://gw:7443",
      caFile: `${dir}/ca`,
      tokenFile: `${dir}/token`,
      certFile: `${dir}/cert`,
      keyFile: `${dir}/key`,
      maxConcurrency: 10,
      keepaliveIntervalMs: 0,
      keepaliveTimeoutMs: 500,
      shutdownGraceMs: 1000,
      workerId: "w-env",
      heartbeatMs: 250,
      reconnectInitialDelayMs: 5,
      reconnectMaxDelayMs: 100,
      reconnectMaxAttempts: 3,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveSettings: a flag wins over its variable, an empty variable is unset", () => {
  const settings = resolveSettings(
    { "max-concurrency": "2", "worker-id": "w-flag" },
    envOf({
      PGFSM_MAX_CONCURRENCY: "10",
      PGFSM_WORKER_ID: "w-env",
      PGFSM_SHUTDOWN_GRACE_MS: "",
      PGFSM_GATEWAY_SOCKET: "/tmp/env.sock",
    }),
  );
  assert(!("error" in settings));
  assertEquals(settings.maxConcurrency, 2);
  assertEquals(settings.workerId, "w-flag");
  assertEquals(settings.shutdownGraceMs, undefined);
  assertEquals(settings.gatewayAddress, "unix:/tmp/env.sock");
  // Nothing set anywhere: the default socket, everything else unset.
  const none = resolveSettings({}, envOf({}));
  assert(!("error" in none));
  assertEquals(
    none.gatewayAddress,
    "unix:/tmp/pgfsm-activity-gateway-workers.sock",
  );
  assertEquals(
    Object.entries(none).filter(([k, v]) =>
      k !== "gatewayAddress" && v !== undefined
    ),
    [],
  );
});

Deno.test("resolveSettings: a gateway flag of either form overrides both variables", () => {
  const env = envOf({ PGFSM_GATEWAY_ADDRESS: "https://gw:7443" });
  const settings = resolveSettings({ "gateway-socket": "/tmp/x.sock" }, env);
  assert(!("error" in settings));
  assertEquals(settings.gatewayAddress, "unix:/tmp/x.sock");
  // Both variables at once is ambiguous.
  const both = resolveSettings(
    {},
    envOf({
      PGFSM_GATEWAY_SOCKET: "/tmp/x.sock",
      PGFSM_GATEWAY_ADDRESS: "https://gw:7443",
    }),
  );
  assert("error" in both);
  assertStringIncludes(both.error, "PGFSM_GATEWAY_SOCKET");
});

Deno.test("resolveSettings: invalid variables are reported by name", () => {
  for (
    const [vars, named] of [
      [{ PGFSM_MAX_CONCURRENCY: "0" }, "PGFSM_MAX_CONCURRENCY"],
      [{ PGFSM_MAX_CONCURRENCY: "two" }, "PGFSM_MAX_CONCURRENCY"],
      [{ PGFSM_KEEPALIVE_TIMEOUT_MS: "0" }, "PGFSM_KEEPALIVE_TIMEOUT_MS"],
      [{ PGFSM_SHUTDOWN_GRACE_MS: "-1" }, "PGFSM_SHUTDOWN_GRACE_MS"],
      [{ PGFSM_HEARTBEAT_MS: "0" }, "PGFSM_HEARTBEAT_MS"],
      [{ PGFSM_RECONNECT_MAX_ATTEMPTS: "x" }, "PGFSM_RECONNECT_MAX_ATTEMPTS"],
      [{ PGFSM_GATEWAY_ADDRESS: "tcp://gw:1" }, "tcp://gw:1"],
      [
        { PGFSM_GATEWAY_TOKEN_FILE: "/nonexistent/t" },
        "PGFSM_GATEWAY_TOKEN_FILE",
      ],
      [{ PGFSM_GATEWAY_CERT_FILE: "/tmp/c" }, "PGFSM_GATEWAY_KEY_FILE"],
    ] as const
  ) {
    const result = resolveSettings({}, envOf(vars));
    assert("error" in result, JSON.stringify(vars));
    assertStringIncludes(result.error, named);
  }
});

Deno.test("runActorWorkerCli - start exits 1 on an invalid variable; a flag overrides it", async () => {
  assertEquals(
    await runActorWorkerCli({
      registrations: REGISTRATIONS,
      args: ["start"],
      env: envOf({ PGFSM_MAX_CONCURRENCY: "zero" }),
    }),
    1,
  );
  // A valid flag overrides the invalid variable.
  assertEquals(
    await runActorWorkerCli({
      registrations: REGISTRATIONS,
      args: ["list", "--max-concurrency", "3"],
      env: envOf({ PGFSM_MAX_CONCURRENCY: "zero" }),
    }),
    0,
  );
});
