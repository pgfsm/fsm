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
