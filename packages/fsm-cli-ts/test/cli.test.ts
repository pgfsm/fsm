import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs/copy";
import { join } from "@std/path";

// Drives the real CLI as a subprocess, SPEC-004's acceptance criteria as the
// checklist. Fixtures live inside this package, not the OS temp dir: a copied
// machine.ts's bare "xstate" import only resolves for files under a Deno
// config recognized at startup (same constraint as @pgfsm/compiler's
// test-helpers.ts, #214). Assumes the process cwd is the repo root.
const CLI = `${Deno.cwd()}/packages/fsm-cli-ts/src/cli/pgfsm.ts`;
const EXAMPLE = `${Deno.cwd()}/apps/fsm-core-example/fsm`;
const ROOT =
  `${Deno.cwd()}/packages/fsm-cli-ts/.test-fixtures/cli-${crypto.randomUUID()}`;
await Deno.mkdir(ROOT, { recursive: true });

// designs/: loose sources outside any project, at paths whose folders are
// deliberately NOT <fsmName>/<vNN>.
const DESIGNS = join(ROOT, "designs");
await Deno.mkdir(join(DESIGNS, "a"), { recursive: true });
await copy(
  `${EXAMPLE}/creditCheck/v01/machine.ts`,
  join(DESIGNS, "a", "machine.ts"),
);
await copy(
  `${EXAMPLE}/creditCheck/v01/fsm.json`,
  join(DESIGNS, "credit.json"),
);
// A plugin-root folder with one FSM, for folder sources.
await Deno.mkdir(join(DESIGNS, "tree", "loan", "v01"), { recursive: true });
await copy(
  `${EXAMPLE}/creditCheck/v01/fsm.json`,
  join(DESIGNS, "tree", "loan", "v01", "fsm.json"),
);

async function pgfsm(
  args: string[],
  cwd = ROOT,
): Promise<{ code: number; out: string }> {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", CLI, "--no-input", ...args],
    cwd,
    env: { PGFSM_SKIP_GO_TIDY: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code, out: dec.decode(stdout) + dec.decode(stderr) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string) {
  return JSON.parse(await Deno.readTextFile(path));
}

const APP = join(ROOT, "my-app");

Deno.test("create --dry-run prints the plan and writes nothing", async () => {
  const { code, out } = await pgfsm([
    "create",
    "my-app",
    "designs/credit.json",
    "-N",
    "creditCheck",
    "-V",
    "v01",
    "--dry-run",
  ]);
  assertEquals(code, 0, out);
  assertStringIncludes(out, "dry run — nothing written");
  assertStringIncludes(out, "async-worker/go");
  assertStringIncludes(out, "fsm/creditCheck/v01");
  assertEquals(await exists(APP), false);
});

Deno.test("create lays out the project with all four async-worker languages and a dependency-free package.json", async () => {
  const { code, out } = await pgfsm([
    "create",
    "my-app",
    "designs/credit.json",
    "-N",
    "creditCheck",
    "-V",
    "v01",
  ]);
  assertEquals(code, 0, out);
  for (
    const f of [
      "pgfsm.config.json",
      "package.json",
      "deno.json",
      "README.md",
      "fsm/creditCheck/v01/fsm.json",
      "sync-worker/typescript/run-sync-worker.ts",
      "sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts",
      "async-worker/typescript/run-async-worker.ts",
      "async-worker/python/run_async_worker.py",
      "async-worker/python/python_actors_registry_generated.py",
      "async-worker/rust/src/main.rs",
      "async-worker/rust/rust-actors-registry.generated.rs",
      "async-worker/go/main.go",
      "async-worker/go/go-actors-registry-generated/registry.go",
    ]
  ) {
    assert(await exists(join(APP, f)), `missing ${f}`);
  }
  const pkg = await readJson(join(APP, "package.json"));
  assertEquals(pkg.dependencies, undefined);
  assertEquals(pkg.devDependencies, undefined);
  assertStringIncludes(pkg.scripts["fsm:add"], "npx -y @pgfsm/cli@");
  assertEquals(Object.keys(pkg.scripts), [
    "fsm:add",
    "db:load",
    "db:pgcron",
    "gateway",
  ]);
  // Sibling tools are pinned to the versions this CLI was built with.
  const versionOf = async (dir: string) =>
    (await readJson(`${Deno.cwd()}/packages/${dir}/deno.json`)).version;
  assertEquals(
    pkg.scripts["db:load"],
    `npx -y @pgfsm/ctl@${await versionOf("fsm-ctl-ts")} fsm load fsm`,
  );
  assertEquals(
    pkg.scripts["db:pgcron"],
    `npx -y @pgfsm/ctl@${await versionOf("fsm-ctl-ts")} pgcron register`,
  );
  assertStringIncludes(
    pkg.scripts.gateway,
    `npx -y -p @pgfsm/async-worker-gateway@${await versionOf(
      "fsm-async-worker-gateway-ts",
    )} -- async-operation-worker-gateway`,
  );
  const readme = await Deno.readTextFile(join(APP, "README.md"));
  const runStack = readme.slice(readme.indexOf("## Run the stack"));
  assert(
    runStack.indexOf("npm run db:load") <
        runStack.indexOf("npm run db:pgcron") &&
      runStack.indexOf("npm run db:pgcron") <
        runStack.indexOf("npm run gateway") &&
      runStack.indexOf("npm run gateway") < runStack.indexOf("deno task dev"),
    "README loads FSMs, registers pgcron, then starts the gateway and workers",
  );

  // Just a marker: nothing records FSM sources without sync (#390).
  const config = await readJson(join(APP, "pgfsm.config.json"));
  assertEquals(Object.keys(config).sort(), ["name", "toolVersion"]);
  assertEquals(config.name, "my-app");
  assertEquals(
    (await readJson(join(APP, "sync-worker/typescript/deno.json"))).name,
    "my-app",
  );
});

Deno.test("create refuses an existing project and a directory inside one", async () => {
  const again = await pgfsm(["create", "my-app"]);
  assertEquals(again.code, 1);
  assertStringIncludes(again.out, "already a pgfsm project");
  assertStringIncludes(again.out, "add");

  const nested = await pgfsm(["create", "my-app/sub"]);
  assertEquals(nested.code, 1);
  assertStringIncludes(nested.out, "inside the pgfsm project");
});

Deno.test("create refuses a non-empty directory", async () => {
  const dir = join(ROOT, "busy");
  await Deno.mkdir(dir);
  await Deno.writeTextFile(join(dir, "notes.txt"), "hi\n");
  const { code, out } = await pgfsm(["create", "busy"]);
  assertEquals(code, 1);
  assertStringIncludes(out, "isn't empty");
});

Deno.test("add outside a project fails with the create hint and writes nothing", async () => {
  const { code, out } = await pgfsm(["add", "designs/credit.json"], DESIGNS);
  assertEquals(code, 1);
  assertStringIncludes(out, "No pgfsm project found");
  assertStringIncludes(out, "create");
  assertEquals(await exists(join(DESIGNS, "fsm")), false);
});

Deno.test("add without a name/version it can't infer fails in --no-input mode, naming the flags", async () => {
  const { code, out } = await pgfsm(
    ["add", join(DESIGNS, "a", "machine.ts")],
    APP,
  );
  assertEquals(code, 1);
  assertStringIncludes(out, "--fsm-name");
  assertStringIncludes(out, "--fsm-version");
  assertEquals(await exists(join(APP, "fsm/a")), false);
});

Deno.test("add from a subdirectory targets the project root and never touches existing stubs", async () => {
  const stub = join(
    APP,
    "sync-worker/typescript/creditCheck/v01/actions/assignSSN/assignSSN.ts",
  );
  const edited = (await Deno.readTextFile(stub)) + "// implemented\n";
  await Deno.writeTextFile(stub, edited);
  const before = new Map<string, string>();
  for (
    const f of [
      "async-worker/typescript/run-async-worker.ts",
      "async-worker/python/pyproject.toml",
      "sync-worker/typescript/deno.json",
    ]
  ) {
    before.set(f, await Deno.readTextFile(join(APP, f)));
  }

  const { code, out } = await pgfsm(
    [
      "add",
      join(DESIGNS, "a", "machine.ts"),
      "--fsm-name",
      "checkout",
      "--fsm-version",
      "v01",
    ],
    join(APP, "async-worker", "python"),
  );
  assertEquals(code, 0, out);
  assertStringIncludes(out, `Using project: ${APP}`);
  assert(await exists(join(APP, "fsm/checkout/v01/fsm.json")));
  assertEquals(await exists(join(APP, "fsm/checkout/v01/machine.ts")), false);
  assert(
    await exists(
      join(
        APP,
        "sync-worker/typescript/checkout/v01/actions/assignSSN/assignSSN.ts",
      ),
    ),
  );
  assertEquals(await Deno.readTextFile(stub), edited);
  for (const [f, content] of before) {
    assertEquals(await Deno.readTextFile(join(APP, f)), content, f);
  }
});

Deno.test("add of an existing name/version is refused with the next version; --force replaces it", async () => {
  const argv = [
    "add",
    join(DESIGNS, "a", "machine.ts"),
    "-N",
    "checkout",
    "-V",
    "v01",
  ];
  const refused = await pgfsm(argv, APP);
  assertEquals(refused.code, 1);
  assertStringIncludes(refused.out, "--force");
  assertStringIncludes(refused.out, "--fsm-version v02");

  const forced = await pgfsm([...argv, "--force"], APP);
  assertEquals(forced.code, 0, forced.out);
});

Deno.test("add of a folder adds each <fsmName>/<vNN> in it", async () => {
  const { code, out } = await pgfsm(["add", join(DESIGNS, "tree")], APP);
  assertEquals(code, 0, out);
  assertStringIncludes(out, "loan/v01");
  assert(await exists(join(APP, "fsm/loan/v01/fsm.json")));
});

Deno.test("add --dry-run writes nothing, not even pgfsm.config.json", async () => {
  const configBefore = await Deno.readTextFile(join(APP, "pgfsm.config.json"));
  const { code, out } = await pgfsm(
    [
      "add",
      join(DESIGNS, "credit.json"),
      "-N",
      "credit",
      "-V",
      "v01",
      "--dry-run",
    ],
    APP,
  );
  assertEquals(code, 0, out);
  assertStringIncludes(out, "fsm/credit/v01");
  assertEquals(await exists(join(APP, "fsm/credit")), false);
  assertEquals(
    await Deno.readTextFile(join(APP, "pgfsm.config.json")),
    configBefore,
  );
});

Deno.test("add --force regenerates a version after its source changes and keeps an edited stub", async () => {
  const stub = join(
    APP,
    "sync-worker/typescript/checkout/v01/guards/allSucceeded/allSucceeded.ts",
  );
  const edited = (await Deno.readTextFile(stub)) + "// mine\n";
  await Deno.writeTextFile(stub, edited);
  const fsmJson = join(APP, "fsm/checkout/v01/fsm.json");
  await Deno.writeTextFile(fsmJson, "{}\n"); // stale compiled output

  const { code, out } = await pgfsm(
    [
      "add",
      join(DESIGNS, "a", "machine.ts"),
      "-N",
      "checkout",
      "-V",
      "v01",
      "--force",
    ],
    APP,
  );
  assertEquals(code, 0, out);
  assertEquals(await Deno.readTextFile(stub), edited);
  assert((await Deno.readTextFile(fsmJson)).length > 10);
});

Deno.test("add --force after the source gains a guard creates its stub and imports it, with nothing to add by hand (#460)", async () => {
  const source = join(DESIGNS, "grows.json");
  await copy(`${EXAMPLE}/creditCheck/v01/fsm.json`, source);
  const argv = ["add", source, "-N", "grows", "-V", "v01"];
  assertEquals((await pgfsm(argv, APP)).code, 0);

  // The design now references a guard no stub exists for yet.
  const json = await Deno.readTextFile(source);
  await Deno.writeTextFile(
    source,
    json.replaceAll('"allSucceeded"', '"allChecksPassed"'),
  );
  const { code, out } = await pgfsm([...argv, "--force"], APP);
  assertEquals(code, 0, out);
  assertEquals(out.includes("missing exports"), false, out);

  const version = join(APP, "sync-worker/typescript/grows/v01");
  assertStringIncludes(
    await Deno.readTextFile(
      join(version, "guards/allChecksPassed/allChecksPassed.ts"),
    ),
    "export function allChecksPassed(",
  );
  assertStringIncludes(
    await Deno.readTextFile(
      join(version, "generated-sync-operation-registry.ts"),
    ),
    'import { allChecksPassed } from "./guards/allChecksPassed/allChecksPassed.ts";',
  );
});

Deno.test("sync is not a command in v1", async () => {
  const { code, out } = await pgfsm(["sync"], APP);
  assertEquals(code, 1);
  assertStringIncludes(out, "Unknown command: sync");
});

Deno.test("--version and --help", async () => {
  const version = await pgfsm(["--version"]);
  assertEquals(version.code, 0);
  // out also carries stderr, where Deno may print workspace warnings.
  const expected =
    (await readJson(`${Deno.cwd()}/packages/fsm-cli-ts/deno.json`)).version;
  assert(version.out.split("\n").includes(expected), version.out);
  const help = await pgfsm(["--help"]);
  assertStringIncludes(help.out, "npx @pgfsm/cli create");
});

Deno.test("cleanup fixtures", async () => {
  await Deno.remove(ROOT, { recursive: true });
});
