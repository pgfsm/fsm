import { parseArgs } from "@std/cli/parse-args";
import { getLogger } from "@logtape/logtape";
import { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";
import { ActivityGatewayClient } from "../gatewayClient.ts";
import { CLI_INVOCATION } from "./gateway-ctl-invocation.ts";
import { PACKAGE_VERSION } from "./version.ts";

const logger = getLogger([
  "@pgfsm/worker",
  "async-op-worker-gateway",
  "ctl",
]);
await configureLogging({
  levels: { [CATEGORY.worker]: isTerminal ? "debug" : "info" },
});

const DEFAULT_TARGET = "unix:/tmp/pgfsm-activity-gateway.sock";
const DEFAULT_TIMEOUT_MS = 5_000;

function printHelp(): void {
  logger.info(`
async-operation-worker-gateway-ctl — CLI client for the Activity Gateway

USAGE
  ${CLI_INVOCATION} <list|invoke> [options]

OPTIONS
  --target <target>              gRPC target (default: ${DEFAULT_TARGET})
  -v, --version                  Print @pgfsm/async-worker-gateway's version and exit
  -h, --help                     Show this help message

INVOKE OPTIONS
  --parent-fsm-name <name>            required
  --parent-fsm-version <ver>          required
  --async-operation-type <type>       required, e.g. internalAsyncOperation
  --async-operation-name <name>       required
  --async-operation-version <ver>     required
  --async-operation-language <lang>   required, e.g. typescript, python, rust, go
  --input <json>                      JSON-encoded input payload (default: null)
  --instance-id <id>                  default: random UUID
  --correlation-id <id>               default: random UUID
  --timeout-ms <ms>                   default: ${DEFAULT_TIMEOUT_MS}

COMMANDS
  list      Calls ListRegisteredActors and prints the actor keys currently registered.
  invoke    Calls Invoke for the given actor identity and prints the result.

DESCRIPTION
  A thin debug/test client for the Activity Gateway's gRPC contract
  (packages/fsm-proto-codegen/proto/fsm-async-worker-gateway-ts/pgfsm/activitygateway/v1/activity_gateway.proto)
  — connects, calls one RPC, prints the result, and exits. Actor identity
  matches ActorPluginValidationResult /
  sidecar/gateway.ts's actorKey():
  parentFsmName@parentFsmVersion@asyncOperationType@asyncOperationName@asyncOperationVersion@asyncOperationLanguage.

EXAMPLE
  ${CLI_INVOCATION} list

  ${CLI_INVOCATION} invoke \\
    --parent-fsm-name creditCheck --parent-fsm-version v01 \\
    --async-operation-type internalAsyncOperation --async-operation-name checkBureau --async-operation-version v01 \\
    --async-operation-language rust --input '{{"ssn":"123"}}'
`);
}

const args = parseArgs(Deno.args, {
  string: [
    "target",
    "parent-fsm-name",
    "parent-fsm-version",
    "async-operation-type",
    "async-operation-name",
    "async-operation-version",
    "async-operation-language",
    "input",
    "instance-id",
    "correlation-id",
    "timeout-ms",
  ],
  boolean: ["help", "version"],
  alias: { h: "help", v: "version" },
});

if (args.version) {
  // Bare, undecorated output (no logger timestamp/category prefix) — see
  // async-operation-worker-gateway.ts's identical --version handling.
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const command = String(args._[0] ?? "");
if (command !== "list" && command !== "invoke") {
  logger.error("First argument must be one of: list, invoke. Got: {command}", {
    command: command || "(none)",
  });
  printHelp();
  Deno.exit(1);
}

const target = args.target ?? DEFAULT_TARGET;
const client = new ActivityGatewayClient({ target });

try {
  if (command === "list") {
    const actors = await client.listRegisteredActors();
    if (actors.length === 0) {
      logger.info("No actors currently registered.");
    } else {
      logger.info("Registered actors ({count}):", { count: actors.length });
      for (const actor of actors) {
        logger.info("  {actor}", { actor });
      }
    }
  } else {
    const requiredFlags = [
      "parent-fsm-name",
      "parent-fsm-version",
      "async-operation-type",
      "async-operation-name",
      "async-operation-version",
      "async-operation-language",
    ] as const;
    const missing = requiredFlags.filter((key) => !args[key]);
    if (missing.length > 0) {
      logger.error("invoke requires: --{missing}", {
        missing: missing.join(", --"),
      });
      printHelp();
      Deno.exit(1);
    }

    let input: unknown = null;
    if (args.input) {
      try {
        input = JSON.parse(args.input);
      } catch (error) {
        logger.error("--input must be valid JSON: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
        Deno.exit(1);
      }
    }

    const result = await client.invokeActor({
      parentFsmName: args["parent-fsm-name"]!,
      parentFsmVersion: args["parent-fsm-version"]!,
      asyncOperationType: args["async-operation-type"]!,
      asyncOperationName: args["async-operation-name"]!,
      asyncOperationVersion: args["async-operation-version"]!,
      asyncOperationLanguage: args["async-operation-language"]!,
      input,
      instanceId: args["instance-id"] ?? crypto.randomUUID(),
      correlationId: args["correlation-id"] ?? crypto.randomUUID(),
      timeoutMs: args["timeout-ms"]
        ? Number(args["timeout-ms"])
        : DEFAULT_TIMEOUT_MS,
    });

    logger.info("Result: {output}", { output: JSON.stringify(result.output) });
  }
} catch (error) {
  const msg = error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
  logger.error("Command failed: {error}", { error: msg });
  client.close();
  Deno.exit(1);
}

client.close();
