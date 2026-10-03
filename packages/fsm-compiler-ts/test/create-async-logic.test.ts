import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createAsyncOperationLogic } from "../src/create-async-logic.ts";

// The per-actor concurrency setting every new actor stub declares (#435),
// between the label comment and the function.
const MC_TS =
  "\n// How many invokes of this actor one worker runs at once. Above 1, the\n// handler must be safe to run concurrently (no unguarded shared state, only\n// concurrency-safe clients). Delivery is at-least-once, so the handler must\n// also be idempotent: the same invoke can arrive more than once.\nexport const maxConcurrency = 1;\n\n";
const MC_PY =
  "\n# How many invokes of this actor one worker runs at once. Above 1, the\n# handler runs on several threads at once and must be thread-safe (no\n# unguarded shared state, only thread-safe clients). Delivery is\n# at-least-once, so the handler must also be idempotent: the same invoke can\n# arrive more than once.\nMAX_CONCURRENCY = 1\n\n\n";
const MC_RS =
  "\n/// How many invokes of this actor one worker runs at once. Above 1, the\n/// handler runs on several threads at once: shared state needs a `Mutex` or\n/// atomics. Delivery is at-least-once, so the handler must also be\n/// idempotent: the same invoke can arrive more than once.\npub const MAX_CONCURRENCY: u32 = 1;\n\n";
const MC_GO =
  "\n// MaxConcurrency is how many invokes of this actor one worker runs at once.\n// Above 1, the handler runs on several goroutines at once: guard shared state\n// with a sync.Mutex, atomics or channels. Delivery is at-least-once, so the\n// handler must also be idempotent: the same invoke can arrive more than once.\nconst MaxConcurrency = 1\n\n";

Deno.test("createAsyncOperationLogic - writes a single actor under <writeRootAbsPath>/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors/<functionName>/<functionName>.<ext>", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    assertEquals(
      file,
      `${dir}/async-worker/typescript/sharedAsyncOperation/v01/actors/checkCreditScore/checkCreditScore.ts`,
    );
    const content = await Deno.readTextFile(file);
    assertEquals(
      content,
      "// Actor: checkCreditScore\n" + MC_TS +
        'export function checkCreditScore(input: unknown): unknown {\n  // TODO: implement actor logic\n  return { input, msg: "checkCreditScore actor invoked by typescript" };\n}\n',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - writes actors-manifest.json under sharedAsyncOperation/<functionVersion>/ with the fixed sharedAsyncOperation identity", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${dir}/async-worker/typescript/sharedAsyncOperation/v01/actors-manifest.json`,
      ),
    );
    assertEquals(manifest, {
      actors: [
        {
          parentFsmName: "sharedAsyncOperation",
          parentFsmVersion: "v01",
          src: "checkCreditScore",
          asyncOperationName: "checkCreditScore",
          asyncOperationType: "sharedAsyncOperation",
          asyncOperationVersion: "v01",
          asyncOperationLanguage: "typescript",
          filePath: "actors/checkCreditScore/checkCreditScore.ts",
          exportedAsyncOperationName: "checkCreditScore",
        },
      ],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - actors-manifest.json accumulates every function at that same functionVersion, not just the one just written", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    await createAsyncOperationLogic(dir, "typescript", "v01", "verifyIdentity");
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${dir}/async-worker/typescript/sharedAsyncOperation/v01/actors-manifest.json`,
      ),
    );
    const srcs = manifest.actors.map((a: { src: string }) => a.src).sort();
    assertEquals(srcs, ["checkCreditScore", "verifyIdentity"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - actors-manifest.json is scoped to its own functionVersion, not shared across versions", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v02",
      "checkCreditScore",
    );
    const v01Manifest = JSON.parse(
      await Deno.readTextFile(
        `${dir}/async-worker/typescript/sharedAsyncOperation/v01/actors-manifest.json`,
      ),
    );
    const v02Manifest = JSON.parse(
      await Deno.readTextFile(
        `${dir}/async-worker/typescript/sharedAsyncOperation/v02/actors-manifest.json`,
      ),
    );
    assertEquals(v01Manifest.actors.length, 1);
    assertEquals(v01Manifest.actors[0].parentFsmVersion, "v01");
    assertEquals(v02Manifest.actors.length, 1);
    assertEquals(v02Manifest.actors[0].parentFsmVersion, "v02");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go also gets actors-manifest.json, with its exportedAsyncOperationName capitalized", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(dir, "go", "v01", "checkCreditScore");
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${dir}/async-worker/go/sharedAsyncOperation/v01/actors-manifest.json`,
      ),
    );
    assertEquals(manifest, {
      actors: [
        {
          parentFsmName: "sharedAsyncOperation",
          parentFsmVersion: "v01",
          src: "checkCreditScore",
          asyncOperationName: "checkCreditScore",
          asyncOperationType: "sharedAsyncOperation",
          asyncOperationVersion: "v01",
          asyncOperationLanguage: "go",
          filePath: "actors/checkCreditScore/checkCreditScore.go",
          exportedAsyncOperationName: "CheckCreditScore",
        },
      ],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - writes generated-registry.ts under sharedAsyncOperation/<functionVersion>/ with the fixed sharedAsyncOperation identity", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    const registryContent = await Deno.readTextFile(
      `${dir}/async-worker/typescript/sharedAsyncOperation/v01/generated-registry.ts`,
    );
    assertStringIncludes(
      registryContent,
      "checkCreditScore as checkCreditScore_v01,",
    );
    assertStringIncludes(
      registryContent,
      "maxConcurrency as checkCreditScore_v01_maxConcurrency,",
    );
    assertStringIncludes(
      registryContent,
      'parentFsmName: "sharedAsyncOperation",',
    );
    assertStringIncludes(registryContent, 'parentFsmVersion: "v01",');
    assertStringIncludes(
      registryContent,
      'asyncOperationType: "sharedAsyncOperation",',
    );
    assertStringIncludes(
      registryContent,
      'asyncOperationName: "checkCreditScore",',
    );
    assertStringIncludes(registryContent, 'asyncOperationVersion: "v01",');
    assertStringIncludes(
      registryContent,
      'asyncOperationLanguage: "typescript",',
    );
    assertStringIncludes(registryContent, "handler: checkCreditScore_v01,");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - a second call at the same functionVersion accumulates in that version's own registry instead of clobbering the first", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    await createAsyncOperationLogic(dir, "typescript", "v01", "verifyIdentity");
    const registryContent = await Deno.readTextFile(
      `${dir}/async-worker/typescript/sharedAsyncOperation/v01/generated-registry.ts`,
    );
    assertStringIncludes(registryContent, "handler: checkCreditScore_v01,");
    assertStringIncludes(registryContent, "handler: verifyIdentity_v01,");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - a different function-version gets its own separate registry file, not merged with any other version's (#332)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v02",
      "checkCreditScore",
    );
    const v01Registry = await Deno.readTextFile(
      `${dir}/async-worker/typescript/sharedAsyncOperation/v01/generated-registry.ts`,
    );
    const v02Registry = await Deno.readTextFile(
      `${dir}/async-worker/typescript/sharedAsyncOperation/v02/generated-registry.ts`,
    );
    assertStringIncludes(
      v01Registry,
      "checkCreditScore as checkCreditScore_v01,",
    );
    assertStringIncludes(
      v01Registry,
      "maxConcurrency as checkCreditScore_v01_maxConcurrency,",
    );
    assertStringIncludes(v01Registry, "handler: checkCreditScore_v01,");
    assertEquals(v01Registry.includes("checkCreditScore_v02"), false);

    assertStringIncludes(
      v02Registry,
      "checkCreditScore as checkCreditScore_v02,",
    );
    assertStringIncludes(
      v02Registry,
      "maxConcurrency as checkCreditScore_v02_maxConcurrency,",
    );
    assertStringIncludes(v02Registry, "handler: checkCreditScore_v02,");
    assertEquals(v02Registry.includes("checkCreditScore_v01"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - writes actors/index.ts barrel under sharedAsyncOperation/<functionVersion>/ re-exporting every typescript actor at that version (#334)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    await createAsyncOperationLogic(dir, "typescript", "v01", "verifyIdentity");
    const barrelContent = await Deno.readTextFile(
      `${dir}/async-worker/typescript/sharedAsyncOperation/v01/actors/index.ts`,
    );
    assertStringIncludes(
      barrelContent,
      'export { checkCreditScore } from "./checkCreditScore/checkCreditScore.ts";',
    );
    assertStringIncludes(
      barrelContent,
      'export { verifyIdentity } from "./verifyIdentity/verifyIdentity.ts";',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - writes actors/__init__.py barrel for python (#334)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(dir, "python", "v01", "checkCreditScore");
    const barrelContent = await Deno.readTextFile(
      `${dir}/async-worker/python/sharedAsyncOperation/v01/actors/__init__.py`,
    );
    assertStringIncludes(
      barrelContent,
      "from .checkCreditScore.checkCreditScore import checkCreditScore",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - writes actors/mod.rs barrel for rust, closing the barrel gap the FSM-scoped aggregate's #[path] include relies on (#334)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(dir, "rust", "v01", "checkCreditScore");
    const barrelContent = await Deno.readTextFile(
      `${dir}/async-worker/rust/sharedAsyncOperation/v01/actors/mod.rs`,
    );
    assertStringIncludes(
      barrelContent,
      '#[path = "checkCreditScore/checkCreditScore.rs"]',
    );
    assertStringIncludes(
      barrelContent,
      "pub use checkCreditScore::checkCreditScore;",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - barrel is scoped to its own functionVersion, not shared across versions", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v02",
      "checkCreditScore",
    );
    const v01Barrel = await Deno.readTextFile(
      `${dir}/async-worker/typescript/sharedAsyncOperation/v01/actors/index.ts`,
    );
    const v02Barrel = await Deno.readTextFile(
      `${dir}/async-worker/typescript/sharedAsyncOperation/v02/actors/index.ts`,
    );
    assertStringIncludes(
      v01Barrel,
      'export { checkCreditScore } from "./checkCreditScore/checkCreditScore.ts";',
    );
    assertStringIncludes(
      v02Barrel,
      'export { checkCreditScore } from "./checkCreditScore/checkCreditScore.ts";',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go writes no actors barrel (Go has no sharedAsyncOperation barrel)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(dir, "go", "v01", "checkCreditScore");
    const barrelExists = await Deno.stat(
      `${dir}/async-worker/go/sharedAsyncOperation/v01/actors/mod.rs`,
    ).then(() => true).catch(() => false);
    assertEquals(barrelExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - also refreshes the FSM-scoped aggregate registry for lang (#336)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    const aggregateContent = await Deno.readTextFile(
      `${dir}/async-worker/typescript/typescript-actors-registry.generated.ts`,
    );
    assertStringIncludes(
      aggregateContent,
      'from "./sharedAsyncOperation/v01/generated-registry.ts";',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - a second call at a different functionVersion keeps both versions' actors in the FSM-scoped aggregate (#336)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v02",
      "verifyIdentity",
    );
    const aggregateContent = await Deno.readTextFile(
      `${dir}/async-worker/typescript/typescript-actors-registry.generated.ts`,
    );
    assertStringIncludes(
      aggregateContent,
      'from "./sharedAsyncOperation/v01/generated-registry.ts";',
    );
    assertStringIncludes(
      aggregateContent,
      'from "./sharedAsyncOperation/v02/generated-registry.ts";',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go also refreshes its FSM-scoped aggregate at async-worker/go/go-actors-registry-generated/ (#336)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const absAppRoot = `${dir}/fsm-core-example`;
    await Deno.mkdir(absAppRoot, { recursive: true });
    await createAsyncOperationLogic(
      absAppRoot,
      "go",
      "v01",
      "checkCreditScore",
    );
    const registryContent = await Deno.readTextFile(
      `${absAppRoot}/async-worker/go/go-actors-registry-generated/registry.go`,
    );
    assertStringIncludes(
      registryContent,
      'ParentFsmName:          "sharedAsyncOperation",',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go writes no registry file (Go has no sharedAsyncOperation registry)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(dir, "go", "v01", "checkCreditScore");
    const registryExists = await Deno.stat(
      `${dir}/async-worker/go/sharedAsyncOperation/generated-registry.go`,
    ).then(() => true).catch(() => false);
    assertEquals(registryExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go actor gets a go.mod rooted at the app root (not one level shallow)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const absAppRoot = `${dir}/fsm-core-example`;
    await Deno.mkdir(absAppRoot, { recursive: true });
    await createAsyncOperationLogic(
      absAppRoot,
      "go",
      "v01",
      "checkCreditScore",
    );
    const goModContent = await Deno.readTextFile(
      `${absAppRoot}/async-worker/go/sharedAsyncOperation/v01/actors/checkCreditScore/go.mod`,
    );
    assertEquals(
      goModContent,
      "module fsm-core-example/sharedasyncoperation/v01/go/actors/checkcreditscore\n\ngo 1.19\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - a stale actor directory (file hand-removed, empty dir left behind) is excluded from a later rebuild of a DIFFERENT actor at the same functionVersion (#324)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "python",
      "v08",
      "checkCreditScoreNirajx",
    );
    // Hand-remove the actor's own file + manifest, but leave the now-empty
    // <name>/ directory behind -- the exact scenario #324 reported. Registries
    // are now scoped per functionVersion (#332), so a stale entry can no
    // longer leak into a *different* version's file the way it originally
    // could into the old single global file -- rebuild a second actor at the
    // *same* v08 instead, to exercise listExistingSharedAsyncOpActors' own
    // stale-exclusion within one version's registry.
    await Deno.remove(
      `${dir}/async-worker/python/sharedAsyncOperation/v08/actors/checkCreditScoreNirajx/checkCreditScoreNirajx.py`,
    );
    await Deno.remove(
      `${dir}/async-worker/python/sharedAsyncOperation/v08/actors-manifest.json`,
    );

    await createAsyncOperationLogic(
      dir,
      "python",
      "v08",
      "verifyIdentity",
    );

    const registryContent = await Deno.readTextFile(
      `${dir}/async-worker/python/sharedAsyncOperation/v08/generated_registry.py`,
    );
    assertEquals(registryContent.includes("checkCreditScoreNirajx"), false);
    assertStringIncludes(registryContent, "verifyIdentity_v08");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go writes its own aggregate at sharedAsyncOperation/go-actors-registry-generated/ (#324)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const absAppRoot = `${dir}/fsm-core-example`;
    await Deno.mkdir(absAppRoot, { recursive: true });
    await createAsyncOperationLogic(
      absAppRoot,
      "go",
      "v08",
      "checkCreditScoreNirajx",
    );

    const goModContent = await Deno.readTextFile(
      `${absAppRoot}/async-worker/go/sharedAsyncOperation/go-actors-registry-generated/go.mod`,
    );
    assertEquals(
      goModContent,
      "module fsm-core-example/sharedasyncoperation/go-actors-registry-generated\n\ngo 1.19\n\n" +
        "require fsm-core-example/sharedasyncoperation/v08/go/actors/checkcreditscorenirajx v0.0.0\n\n" +
        "replace fsm-core-example/sharedasyncoperation/v08/go/actors/checkcreditscorenirajx => ../v08/actors/checkCreditScoreNirajx\n",
    );

    const registryContent = await Deno.readTextFile(
      `${absAppRoot}/async-worker/go/sharedAsyncOperation/go-actors-registry-generated/registry.go`,
    );
    assertStringIncludes(
      registryContent,
      'checkCreditScoreNirajx_v08 "fsm-core-example/sharedasyncoperation/v08/go/actors/checkcreditscorenirajx"',
    );
    assertStringIncludes(
      registryContent,
      'ParentFsmName:          "sharedAsyncOperation",',
    );
    assertStringIncludes(
      registryContent,
      'AsyncOperationType:     "sharedAsyncOperation",',
    );
    assertStringIncludes(
      registryContent,
      "Handler:                checkCreditScoreNirajx_v08.CheckCreditScoreNirajx,",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go aggregate accumulates across repeated calls (unlike TS/Python/Rust's now-per-functionVersion registry, #324's Go aggregate stays a single global file across every version)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(dir, "go", "v01", "checkCreditScore");
    await createAsyncOperationLogic(dir, "go", "v01", "verifyIdentity");
    const registryContent = await Deno.readTextFile(
      `${dir}/async-worker/go/sharedAsyncOperation/go-actors-registry-generated/registry.go`,
    );
    assertStringIncludes(
      registryContent,
      "Handler:                checkCreditScore_v01.CheckCreditScore,",
    );
    assertStringIncludes(
      registryContent,
      "Handler:                verifyIdentity_v01.VerifyIdentity,",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - rejects a version that doesn't match the vNN convention", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () =>
        createAsyncOperationLogic(dir, "typescript", "1", "checkCreditScore"),
      Error,
      "Invalid version",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
