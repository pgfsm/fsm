// test-apps/debug-only is a committed `pgfsm create` project: its npm scripts
// must pin the sibling tools at this checkout's versions, as a fresh `create`
// would (#491). After bumping one of them, regenerate the project's
// package.json with the local CLI (`deno task pgfsm create <scratch>/debug-only`
// and copy its package.json over).
import { assertEquals } from "@std/assert";

const repo = new URL("../../../", import.meta.url);

async function versionOf(packageDir: string): Promise<string> {
  const denoJson = JSON.parse(
    await Deno.readTextFile(new URL(`packages/${packageDir}/deno.json`, repo)),
  );
  return denoJson.version;
}

Deno.test("test-apps/debug-only pins this checkout's cli, ctl and gateway", async () => {
  const { scripts } = JSON.parse(
    await Deno.readTextFile(new URL("test-apps/debug-only/package.json", repo)),
  ) as { scripts: Record<string, string> };
  const pins = (
    pattern: RegExp,
  ) => [
    ...new Set(
      Object.values(scripts).flatMap((script) =>
        [...script.matchAll(pattern)].map((match) => match[1])
      ),
    ),
  ];

  assertEquals(pins(/@pgfsm\/cli@(\S+)/g), [await versionOf("fsm-cli-ts")]);
  assertEquals(pins(/@pgfsm\/ctl@(\S+)/g), [await versionOf("fsm-ctl-ts")]);
  assertEquals(pins(/@pgfsm\/async-worker-gateway@(\S+)/g), [
    await versionOf("fsm-async-worker-gateway-ts"),
  ]);
});
