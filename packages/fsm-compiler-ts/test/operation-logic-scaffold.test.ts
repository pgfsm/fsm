import { assertEquals, assertExists } from "@std/assert";
import {
  formatTsFilesBestEffort,
  renderOperationModule,
  toRegisteredActor,
  toWrittenActor,
  writeActorFile,
  writeActorsBarrel,
  writeActorsManifest,
  writeActorsRegistry,
  writeAggregateActorsRegistry,
  writeAggregateGoRegistry,
  writeAggregateSyncOperationRegistry,
  writeSyncOperationRegistry,
  writeSyncWorkerRunner,
  writeWorkerSdk,
} from "../src/operation-logic-scaffold.ts";
import type {
  ActorReference,
  OperationKind,
  OperationLang,
  RegisteredActor,
  WrittenActor,
} from "../src/types/index.ts";

type Case = {
  lang: OperationLang;
  kind: OperationKind;
  name: string;
  expected: string;
};

// A single stub in a module ends the file — renderOperationModule collapses
// the template's blank-line separator down to one trailing newline, matching
// `deno fmt`'s convention (see withSingleTrailingNewline in
// operation-logic-scaffold.ts).
const cases: Case[] = [
  // typescript
  {
    lang: "typescript",
    kind: "actions",
    name: "sendEmail",
    expected:
      "// Action: sendEmail\nexport function sendEmail(context: any, event: any) {\n  // TODO: implement\n}\n",
  },
  {
    lang: "typescript",
    kind: "guards",
    name: "isEligible",
    expected:
      "// Guard: isEligible\nexport function isEligible(context: any, event: any) {\n  // TODO: implement\n  return true;\n}\n",
  },
  {
    lang: "typescript",
    kind: "delays",
    name: "cooldown",
    expected:
      "// Delay: cooldown\nexport function delaycooldown(context: any, event: any): number {\n  // TODO: implement delay logic (return ms)\n  return 0;\n}\n",
  },
  {
    lang: "typescript",
    kind: "actors",
    name: "creditCheck",
    expected:
      '// Actor: creditCheck\nexport function creditCheck(input: unknown): unknown {\n  // TODO: implement actor logic\n  return { input, msg: "creditCheck actor invoked by typescript" };\n}\n',
  },
  // python
  {
    lang: "python",
    kind: "actions",
    name: "sendEmail",
    expected:
      "# Action: sendEmail\ndef sendEmail(context, event):\n    # TODO: implement\n    pass\n",
  },
  {
    lang: "python",
    kind: "guards",
    name: "isEligible",
    expected:
      "# Guard: isEligible\ndef isEligible(context, event):\n    # TODO: implement\n    return True\n",
  },
  {
    lang: "python",
    kind: "delays",
    name: "cooldown",
    expected:
      "# Delay: cooldown\ndef delaycooldown(context, event):\n    # TODO: implement delay logic (return ms)\n    return 0\n",
  },
  {
    lang: "python",
    kind: "actors",
    name: "creditCheck",
    expected:
      '# Actor: creditCheck\ndef creditCheck(input):\n    # TODO: implement actor logic\n    return {"input": input, "msg": "creditCheck actor invoked by python"}\n',
  },
  // rust
  {
    lang: "rust",
    kind: "actions",
    name: "sendEmail",
    expected:
      "// Action: sendEmail\n#[allow(non_snake_case)]\npub fn sendEmail(context: &serde_json::Value, event: &serde_json::Value) {\n    // TODO: implement\n}\n",
  },
  {
    lang: "rust",
    kind: "guards",
    name: "isEligible",
    expected:
      "// Guard: isEligible\n#[allow(non_snake_case)]\npub fn isEligible(context: &serde_json::Value, event: &serde_json::Value) -> bool {\n    // TODO: implement\n    true\n}\n",
  },
  {
    lang: "rust",
    kind: "delays",
    name: "cooldown",
    expected:
      "// Delay: cooldown\n#[allow(non_snake_case)]\npub fn delaycooldown(context: &serde_json::Value, event: &serde_json::Value) -> u64 {\n    // TODO: implement delay logic (return ms)\n    0\n}\n",
  },
  {
    lang: "rust",
    kind: "actors",
    name: "creditCheck",
    expected:
      '// Actor: creditCheck\n#[allow(non_snake_case)]\npub fn creditCheck(input: serde_json::Value) -> serde_json::Value {\n    // TODO: implement actor logic\n    serde_json::json!({ "input": input, "msg": "creditCheck actor invoked by rust" })\n}\n',
  },
  // go (renderOperationModule prefixes the `package <kind>` header — accounted
  // for separately below, these cases cover the per-name stub only)
  {
    lang: "go",
    kind: "actions",
    name: "sendEmail",
    expected:
      "// Action: sendEmail\nfunc sendEmail(context map[string]any, event map[string]any) {\n\t// TODO: implement\n}\n",
  },
  {
    lang: "go",
    kind: "guards",
    name: "isEligible",
    expected:
      "// Guard: isEligible\nfunc isEligible(context map[string]any, event map[string]any) bool {\n\t// TODO: implement\n\treturn true\n}\n",
  },
  {
    lang: "go",
    kind: "delays",
    name: "cooldown",
    expected:
      "// Delay: cooldown\nfunc delaycooldown(context map[string]any, event map[string]any) int64 {\n\t// TODO: implement delay logic (return ms)\n\treturn 0\n}\n",
  },
  {
    lang: "go",
    kind: "actors",
    name: "creditCheck",
    expected:
      // Go exports (capitalizes) actor function names for cross-package
      // access — see toGoExportedName / #83. Other kinds/languages don't.
      '// Actor: creditCheck\nfunc CreditCheck(input any) (any, error) {\n\t// TODO: implement actor logic\n\treturn map[string]any{"input": input, "msg": "creditCheck actor invoked by go"}, nil\n}\n',
  },
];

for (const { lang, kind, name, expected } of cases) {
  Deno.test(`renderOperationModule - ${lang}/${kind}`, () => {
    const goHeader = lang === "go" ? `package ${kind}\n\n` : "";
    assertEquals(
      renderOperationModule(lang, kind, [name]),
      goHeader + expected,
    );
  });
}

Deno.test("renderOperationModule - multiple stubs keep a blank-line separator between them, single trailing newline at the end", () => {
  const out = renderOperationModule("typescript", "actions", [
    "sendEmail",
    "sendSms",
  ]);
  assertEquals(
    out,
    "// Action: sendEmail\nexport function sendEmail(context: any, event: any) {\n  // TODO: implement\n}\n" +
      "\n" +
      "// Action: sendSms\nexport function sendSms(context: any, event: any) {\n  // TODO: implement\n}\n",
  );
});

Deno.test("writeActorFile - go actor gets a package header, exported (capitalized) function, and its own subfolder", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actor: ActorReference = { src: "creditCheck" };
    const file = await writeActorFile(dir, "go", actor);
    assertEquals(file, `${dir}/go/actors/creditCheck/creditCheck.go`);
    const content = await Deno.readTextFile(file);
    assertEquals(
      content,
      'package actors\n\n// Actor: creditCheck\nfunc CreditCheck(input any) (any, error) {\n\t// TODO: implement actor logic\n\treturn map[string]any{"input": input, "msg": "creditCheck actor invoked by go"}, nil\n}\n',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorFile - go actor also writes its own go.mod, module path derived from the FSM/version/actor folder names", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const absFolderPath = `${dir}/apps/fsm-core-example/fsm/creditCheck/v01`;
    await Deno.mkdir(absFolderPath, { recursive: true });
    const actor: ActorReference = { src: "checkBureau" };
    await writeActorFile(absFolderPath, "go", actor);
    const goModContent = await Deno.readTextFile(
      `${absFolderPath}/go/actors/checkBureau/go.mod`,
    );
    assertEquals(
      goModContent,
      "module fsm-core-example/creditcheck/v01/go/actors/checkbureau\n\ngo 1.19\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorFile - appRootOverride wins over the path-offset appRoot derivation (for folder layouts that don't nest at the standard plugin-root depth)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Only <appRoot>/shared-async-op/<version> deep — one level shallower
    // than the fsm/ plugin-root layout the default offset assumes.
    const absFolderPath = `${dir}/apps/fsm-core-example/shared-async-op/v01`;
    await Deno.mkdir(absFolderPath, { recursive: true });
    const actor: ActorReference = { src: "checkCreditScore" };
    await writeActorFile(absFolderPath, "go", actor, "fsm-core-example");
    const goModContent = await Deno.readTextFile(
      `${absFolderPath}/go/actors/checkCreditScore/go.mod`,
    );
    assertEquals(
      goModContent,
      "module fsm-core-example/shared-async-op/v01/go/actors/checkcreditscore\n\ngo 1.19\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorFile - typescript actor has no package header", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actor: ActorReference = { src: "creditCheck" };
    const file = await writeActorFile(dir, "typescript", actor);
    assertEquals(file, `${dir}/typescript/actors/creditCheck/creditCheck.ts`);
    const content = await Deno.readTextFile(file);
    assertEquals(
      content,
      '// Actor: creditCheck\nexport function creditCheck(input: unknown): unknown {\n  // TODO: implement actor logic\n  return { input, msg: "creditCheck actor invoked by typescript" };\n}\n',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorFile - typescript actor with a long name is wrapped to pass `deno fmt --check` (see #139)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Long enough that the single-line `return { input, msg: "..." }` stub
    // overflows deno fmt's line width. writeActorFile itself only writes —
    // formatting is the caller's responsibility (batched at the end of a
    // whole scaffolding run, see generate-async-operation-logic.ts), so this
    // test does that one step explicitly to verify the wrapped output still
    // matches what `deno fmt --check` expects.
    const actor: ActorReference = { src: "CheckingCreditScores3parallel" };
    const file = await writeActorFile(dir, "typescript", actor);
    await formatTsFilesBestEffort([file]);
    const content = await Deno.readTextFile(file);
    assertEquals(
      content,
      "// Actor: CheckingCreditScores3parallel\n" +
        "export function CheckingCreditScores3parallel(input: unknown): unknown {\n" +
        "  // TODO: implement actor logic\n" +
        "  return {\n" +
        "    input,\n" +
        '    msg: "CheckingCreditScores3parallel actor invoked by typescript",\n' +
        "  };\n" +
        "}\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("toWrittenActor - builds record matching writeActorFile's path convention", () => {
  const actor: ActorReference = { src: "checkBureau" };
  assertEquals(toWrittenActor("typescript", actor), {
    src: "checkBureau",
    fileBaseName: "checkBureau",
    asyncOperationLanguage: "typescript",
    filePath: "actors/checkBureau/checkBureau.ts",
    exportedName: "checkBureau",
  });
});

Deno.test("toWrittenActor - go capitalizes exportedName for cross-package export, src is untouched", () => {
  const actor: ActorReference = { src: "checkBureau" };
  assertEquals(toWrittenActor("go", actor), {
    src: "checkBureau",
    fileBaseName: "checkBureau",
    asyncOperationLanguage: "go",
    filePath: "actors/checkBureau/checkBureau.go",
    exportedName: "CheckBureau",
  });
});

Deno.test("writeActorsManifest - writes all actors across all languages, carrying the full activity-registration identity", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actors: RegisteredActor[] = [
      toRegisteredActor(CREDIT_CHECK_V01, "typescript", {
        src: "checkBureau",
      }),
      toRegisteredActor(CREDIT_CHECK_V01, "python", {
        src: "checkBureauPython",
      }),
      toRegisteredActor(CREDIT_CHECK_V01, "go", { src: "checkBureauGo" }),
    ];
    const file = await writeActorsManifest(dir, actors);
    assertEquals(file, `${dir}/actors-manifest.json`);
    const manifest = JSON.parse(await Deno.readTextFile(file));
    assertEquals(manifest, {
      actors: [
        {
          parentFsmName: "creditCheck",
          parentFsmVersion: "v01",
          src: "checkBureau",
          asyncOperationName: "checkBureau",
          asyncOperationType: "internalAsyncOperation",
          asyncOperationVersion: "v01",
          asyncOperationLanguage: "typescript",
          filePath: "actors/checkBureau/checkBureau.ts",
          exportedAsyncOperationName: "checkBureau",
        },
        {
          parentFsmName: "creditCheck",
          parentFsmVersion: "v01",
          src: "checkBureauPython",
          asyncOperationName: "checkBureauPython",
          asyncOperationType: "internalAsyncOperation",
          asyncOperationVersion: "v01",
          asyncOperationLanguage: "python",
          filePath: "actors/checkBureauPython/checkBureauPython.py",
          exportedAsyncOperationName: "checkBureauPython",
        },
        {
          parentFsmName: "creditCheck",
          parentFsmVersion: "v01",
          src: "checkBureauGo",
          asyncOperationName: "checkBureauGo",
          asyncOperationType: "internalAsyncOperation",
          asyncOperationVersion: "v01",
          asyncOperationLanguage: "go",
          filePath: "actors/checkBureauGo/checkBureauGo.go",
          exportedAsyncOperationName: "CheckBureauGo",
        },
      ],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsManifest - writes an empty manifest when there are no actors", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeActorsManifest(dir, []);
    const manifest = JSON.parse(await Deno.readTextFile(file));
    assertEquals(manifest, { actors: [] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A version-folder path matching the `<pluginRoot>/<asyncOperationName>/<version>`
// convention, so toRegisteredActor can derive parentFsmName/parentFsmVersion.
const CREDIT_CHECK_V01 = "/repo/apps/fsm-core-example/fsm/creditCheck/v01";

const actorsForBarrelTests: RegisteredActor[] = [
  toRegisteredActor(CREDIT_CHECK_V01, "typescript", { src: "checkBureau" }),
  toRegisteredActor(CREDIT_CHECK_V01, "typescript", {
    src: "determineMiddleScore",
  }),
  toRegisteredActor(CREDIT_CHECK_V01, "python", { src: "checkBureauPython" }),
  toRegisteredActor(CREDIT_CHECK_V01, "rust", { src: "checkBureau" }),
];

Deno.test("writeActorsBarrel - typescript re-exports only typescript actors", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeActorsBarrel(
      dir,
      actorsForBarrelTests,
      "typescript",
    );
    assertEquals(file, `${dir}/typescript/actors/index.ts`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      'export { checkBureau } from "./checkBureau/checkBureau.ts";\n' +
        'export { determineMiddleScore } from "./determineMiddleScore/determineMiddleScore.ts";\n',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsBarrel - python writes an __init__.py with namespace-package imports", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeActorsBarrel(dir, actorsForBarrelTests, "python");
    assertEquals(file, `${dir}/python/actors/__init__.py`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "from .checkBureauPython.checkBureauPython import checkBureauPython\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsBarrel - rust writes a mod.rs with #[path] attributes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeActorsBarrel(dir, actorsForBarrelTests, "rust");
    assertEquals(file, `${dir}/rust/actors/mod.rs`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      '#[path = "checkBureau/checkBureau.rs"]\n' +
        "#[allow(non_snake_case)]\n" +
        "mod checkBureau;\n" +
        "pub use checkBureau::checkBureau;\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsBarrel - writes nothing when there are no actors for that language", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actors: WrittenActor[] = [
      toWrittenActor("python", { src: "checkBureauPython" }),
    ];
    const file = await writeActorsBarrel(dir, actors, "typescript");
    assertEquals(file, undefined);
    let existsErr: unknown;
    try {
      await Deno.stat(`${dir}/typescript`);
    } catch (err) {
      existsErr = err;
    }
    assertExists(existsErr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsRegistry - typescript carries the full activity-registration identity per actor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeActorsRegistry(
      dir,
      actorsForBarrelTests,
      "typescript",
    );
    assertEquals(file, `${dir}/typescript/generated-registry.ts`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        'import { checkBureau } from "./actors/checkBureau/checkBureau.ts";\n' +
        'import { determineMiddleScore } from "./actors/determineMiddleScore/determineMiddleScore.ts";\n' +
        "\n" +
        "export type ActorRegistration = {\n" +
        "  parentFsmName: string;\n" +
        "  parentFsmVersion: string;\n" +
        "  asyncOperationType: string;\n" +
        "  asyncOperationName: string;\n" +
        "  asyncOperationVersion: string;\n" +
        "  asyncOperationLanguage: string;\n" +
        "  handler: (input: unknown) => unknown;\n" +
        "};\n" +
        "\n" +
        "export const ACTOR_REGISTRATIONS: ActorRegistration[] = [\n" +
        "  {\n" +
        '    parentFsmName: "creditCheck",\n' +
        '    parentFsmVersion: "v01",\n' +
        '    asyncOperationType: "internalAsyncOperation",\n' +
        '    asyncOperationName: "checkBureau",\n' +
        '    asyncOperationVersion: "v01",\n' +
        '    asyncOperationLanguage: "typescript",\n' +
        "    handler: checkBureau,\n" +
        "  },\n" +
        "  {\n" +
        '    parentFsmName: "creditCheck",\n' +
        '    parentFsmVersion: "v01",\n' +
        '    asyncOperationType: "internalAsyncOperation",\n' +
        '    asyncOperationName: "determineMiddleScore",\n' +
        '    asyncOperationVersion: "v01",\n' +
        '    asyncOperationLanguage: "typescript",\n' +
        "    handler: determineMiddleScore,\n" +
        "  },\n" +
        "];\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsRegistry - python carries the full activity-registration identity per actor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeActorsRegistry(
      dir,
      actorsForBarrelTests,
      "python",
    );
    assertEquals(file, `${dir}/python/generated_registry.py`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "# AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        "from .actors.checkBureauPython.checkBureauPython import checkBureauPython\n" +
        "\n" +
        "ACTOR_REGISTRATIONS = [\n" +
        "    {\n" +
        '        "parent_fsm_name": "creditCheck",\n' +
        '        "parent_fsm_version": "v01",\n' +
        '        "async_operation_type": "internalAsyncOperation",\n' +
        '        "async_operation_name": "checkBureauPython",\n' +
        '        "async_operation_version": "v01",\n' +
        '        "async_operation_language": "python",\n' +
        '        "handler": checkBureauPython,\n' +
        "    },\n" +
        "]\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsRegistry - rust reuses the barrel's #[path] module instead of redeclaring it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeActorsRegistry(dir, actorsForBarrelTests, "rust");
    assertEquals(file, `${dir}/rust/generated_registry.rs`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        '#[path = "actors/mod.rs"]\n' +
        "mod actors;\n" +
        "\n" +
        "pub struct ActorRegistration {\n" +
        "    pub parent_fsm_name: &'static str,\n" +
        "    pub parent_fsm_version: &'static str,\n" +
        "    pub async_operation_type: &'static str,\n" +
        "    pub async_operation_name: &'static str,\n" +
        "    pub async_operation_version: &'static str,\n" +
        "    pub async_operation_language: &'static str,\n" +
        "    pub handler: fn(serde_json::Value) -> serde_json::Value,\n" +
        "}\n" +
        "\n" +
        "pub fn actor_registrations() -> Vec<ActorRegistration> {\n" +
        "    vec![\n" +
        "        ActorRegistration {\n" +
        '            parent_fsm_name: "creditCheck",\n' +
        '            parent_fsm_version: "v01",\n' +
        '            async_operation_type: "internalAsyncOperation",\n' +
        '            async_operation_name: "checkBureau",\n' +
        '            async_operation_version: "v01",\n' +
        '            async_operation_language: "rust",\n' +
        "            handler: actors::checkBureau,\n" +
        "        },\n" +
        "    ]\n" +
        "}\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeActorsRegistry - writes nothing when there are no actors for that language", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actors: RegisteredActor[] = [
      toRegisteredActor(CREDIT_CHECK_V01, "python", {
        src: "checkBureauPython",
      }),
    ];
    const file = await writeActorsRegistry(dir, actors, "typescript");
    assertEquals(file, undefined);
    let existsErr: unknown;
    try {
      await Deno.stat(`${dir}/typescript`);
    } catch (err) {
      existsErr = err;
    }
    assertExists(existsErr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeSyncOperationRegistry - combines actions/guards/delays into one self-describing array, delay handlers use the prefixed import name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeSyncOperationRegistry(
      dir,
      "creditCheck",
      "v01",
      "typescript",
      ["assignSSN"],
      ["allSucceeded"],
      ["myDelay"],
    );
    assertEquals(file, `${dir}/generated-sync-operation-registry.ts`);
    const content = await Deno.readTextFile(file);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        'import { assignSSN } from "./actions/index.ts";\n' +
        'import { allSucceeded } from "./guards/index.ts";\n' +
        'import { delaymyDelay } from "./delays/index.ts";\n' +
        "\n" +
        "export type SyncOperationRegistration = {\n" +
        "  fsmName: string;\n" +
        "  fsmVersion: string;\n" +
        '  syncOperationType: "action" | "guard" | "delay";\n' +
        "  syncOperationName: string;\n" +
        "  syncOperationLanguage: string;\n" +
        "  handler: (...args: unknown[]) => unknown;\n" +
        "};\n" +
        "\n" +
        "export const SYNC_OPERATION_REGISTRATIONS: SyncOperationRegistration[] = [\n" +
        "  {\n" +
        '    fsmName: "creditCheck",\n' +
        '    fsmVersion: "v01",\n' +
        '    syncOperationType: "action",\n' +
        '    syncOperationName: "assignSSN",\n' +
        '    syncOperationLanguage: "typescript",\n' +
        "    handler: assignSSN,\n" +
        "  },\n" +
        "  {\n" +
        '    fsmName: "creditCheck",\n' +
        '    fsmVersion: "v01",\n' +
        '    syncOperationType: "guard",\n' +
        '    syncOperationName: "allSucceeded",\n' +
        '    syncOperationLanguage: "typescript",\n' +
        "    handler: allSucceeded,\n" +
        "  },\n" +
        "  {\n" +
        '    fsmName: "creditCheck",\n' +
        '    fsmVersion: "v01",\n' +
        '    syncOperationType: "delay",\n' +
        '    syncOperationName: "myDelay",\n' +
        '    syncOperationLanguage: "typescript",\n' +
        "    handler: delaymyDelay,\n" +
        "  },\n" +
        "];\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeSyncOperationRegistry - a kind with no names is skipped entirely (no empty import statement)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeSyncOperationRegistry(
      dir,
      "creditCheck",
      "v01",
      "typescript",
      ["assignSSN"],
      [],
      [],
    );
    const content = await Deno.readTextFile(file);
    assertEquals(content.includes("guards/index.ts"), false);
    assertEquals(content.includes("delays/index.ts"), false);
    assertEquals(
      content.includes('import { assignSSN } from "./actions/index.ts";'),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeAggregateSyncOperationRegistry - returns undefined when no <fsmName>/<fsmVersion> group exists yet", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeAggregateSyncOperationRegistry(
      `${dir}/sync-worker/typescript`,
    );
    assertEquals(file, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeAggregateSyncOperationRegistry - combines every <fsmName>/<fsmVersion>'s registry into one array, sorted by fsmName/fsmVersion", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const tsDir = `${dir}/sync-worker/typescript`;
    // Written out of order -- the aggregate should still come out sorted.
    await writeSyncOperationRegistry(
      `${tsDir}/otherFsm/v02`,
      "otherFsm",
      "v02",
      "typescript",
      [],
      ["allSucceeded"],
      [],
    );
    await writeSyncOperationRegistry(
      `${tsDir}/creditCheck/v01`,
      "creditCheck",
      "v01",
      "typescript",
      ["assignSSN"],
      [],
      [],
    );

    const file = await writeAggregateSyncOperationRegistry(tsDir);
    assertEquals(
      file,
      `${tsDir}/aggregate-generated-sync-operation-registry.ts`,
    );
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        'import { SYNC_OPERATION_REGISTRATIONS as creditcheck_v01 } from "./creditCheck/v01/generated-sync-operation-registry.ts";\n' +
        'import { SYNC_OPERATION_REGISTRATIONS as otherfsm_v02 } from "./otherFsm/v02/generated-sync-operation-registry.ts";\n' +
        "\n" +
        "export const SYNC_OPERATION_REGISTRATIONS = [\n" +
        "  ...creditcheck_v01,\n" +
        "  ...otherfsm_v02,\n" +
        "];\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeSyncWorkerRunner - writes run-sync-worker.ts with dotenv, @pgfsm/logging, and graceful shutdown wired up, plus a deno.json declaring every bare import, random name by default", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { runFile, denoJsonFile } = await writeSyncWorkerRunner(dir);
    assertEquals(runFile, `${dir}/run-sync-worker.ts`);
    assertEquals(denoJsonFile, `${dir}/deno.json`);

    const runContent = await Deno.readTextFile(runFile);
    assertEquals(
      runContent.startsWith(
        "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n",
      ),
      true,
    );
    // dotenv
    assertEquals(runContent.includes('import dotenv from "dotenv";'), true);
    assertEquals(
      runContent.includes('dotenv.config({ path: ".env" });'),
      true,
    );
    // @pgfsm/logging: configureLogging + CATEGORY + isTerminal
    assertEquals(
      runContent.includes(
        'import { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";',
      ),
      true,
    );
    assertEquals(runContent.includes("await configureLogging("), true);
    assertEquals(runContent.includes("isTerminal ?"), true);
    // Graceful shutdown via AbortController + Deno signal listeners.
    assertEquals(
      runContent.includes('Deno.addSignalListener("SIGINT", onSignal);'),
      true,
    );
    assertEquals(
      runContent.includes('Deno.addSignalListener("SIGTERM", onSignal);'),
      true,
    );
    assertEquals(runContent.includes("new AbortController()"), true);
    // The aggregate + @pgfsm/sync-worker, with the signal threaded through.
    assertEquals(
      runContent.includes(
        'import { SYNC_OPERATION_REGISTRATIONS } from "./aggregate-generated-sync-operation-registry.ts";',
      ),
      true,
    );
    assertEquals(
      runContent.includes('import { runFsmlet } from "@pgfsm/sync-worker";'),
      true,
    );
    assertEquals(runContent.includes("signal: controller.signal"), true);

    const denoJsonContent = await Deno.readTextFile(denoJsonFile);
    const parsed = JSON.parse(denoJsonContent);
    // No projectName given -- falls back to a random sync-worker-<8 hex chars>.
    assertEquals(/^sync-worker-[0-9a-f]{8}$/.test(parsed.name), true);
    assertEquals(
      parsed.description.includes("@pgfsm/compiler") &&
        parsed.description.includes("@pgfsm/sync-worker"),
      true,
    );
    // Deno warns "exports" should accompany a "name" (JSR-publish config
    // convention) -- harmless either way here, but this silences it.
    assertEquals(parsed.exports, "./run-sync-worker.ts");
    for (
      const [specifier, prefix] of [
        ["@pgfsm/sync-worker", "npm:@pgfsm/sync-worker@"],
        ["@pgfsm/logging", "npm:@pgfsm/logging@"],
        ["@logtape/logtape", "npm:@logtape/logtape@"],
        ["dotenv", "npm:dotenv@"],
      ] as const
    ) {
      assertEquals(typeof parsed.imports[specifier], "string");
      assertEquals(parsed.imports[specifier].startsWith(prefix), true);
    }
    assertEquals(parsed.tasks.dev, "deno run --allow-all run-sync-worker.ts");
    assertEquals(
      parsed.tasks["dev:watch"],
      "deno run --allow-all --watch=. run-sync-worker.ts",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeSyncWorkerRunner - uses the given projectName as deno.json's name instead of a random one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { denoJsonFile } = await writeSyncWorkerRunner(
      dir,
      "creditcheck-worker",
    );
    const parsed = JSON.parse(await Deno.readTextFile(denoJsonFile));
    assertEquals(parsed.name, "creditcheck-worker");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const OTHER_FSM_V02 = "/repo/apps/fsm-core-example/fsm/otherFsm/v02";

const actorsForAggregateTests: RegisteredActor[] = [
  ...actorsForBarrelTests,
  toRegisteredActor(OTHER_FSM_V02, "typescript", { src: "someActor" }),
  toRegisteredActor(OTHER_FSM_V02, "python", { src: "someActorPy" }),
  toRegisteredActor(OTHER_FSM_V02, "rust", { src: "someActorRs" }),
];

Deno.test("writeAggregateActorsRegistry - typescript re-imports and flattens each FSM-version's registry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeAggregateActorsRegistry(
      dir,
      actorsForAggregateTests,
      "typescript",
    );
    assertEquals(
      file,
      `${dir}/async-worker/typescript/typescript-actors-registry.generated.ts`,
    );
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        'import { ACTOR_REGISTRATIONS as creditcheck_v01 } from "./creditCheck/v01/generated-registry.ts";\n' +
        'import { ACTOR_REGISTRATIONS as otherfsm_v02 } from "./otherFsm/v02/generated-registry.ts";\n' +
        "\n" +
        "export const ACTOR_REGISTRATIONS = [\n" +
        "  ...creditcheck_v01,\n" +
        "  ...otherfsm_v02,\n" +
        "];\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeAggregateActorsRegistry - python statically imports each FSM-version's registry via a dotted path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeAggregateActorsRegistry(
      dir,
      actorsForAggregateTests,
      "python",
    );
    assertEquals(
      file,
      `${dir}/async-worker/python/python_actors_registry_generated.py`,
    );
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "# AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        "# Each FSM-version's registry is imported statically via a dotted path\n" +
        "# (fsm-compiler-ts validates every FSM-name/version folder name is a valid\n" +
        "# Python identifier before generating this file, precisely so this can be a\n" +
        "# plain import instead of a runtime file-path load). The plugin root itself\n" +
        "# is added to sys.path so each FSM-name folder resolves as a namespace\n" +
        "# package -- Python has no relative-path import syntax like TS's\n" +
        '# `"../../x/y.ts"` or Rust\'s `#[path]`, so this is the static-import\n' +
        "# equivalent for a sibling directory.\n" +
        "import os\n" +
        "import sys\n" +
        "\n" +
        "_PLUGIN_ROOT = os.path.abspath(\n" +
        '    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".")\n' +
        ")\n" +
        "if _PLUGIN_ROOT not in sys.path:\n" +
        "    sys.path.insert(0, _PLUGIN_ROOT)\n" +
        "\n" +
        "from creditCheck.v01.generated_registry import ACTOR_REGISTRATIONS as creditcheck_v01\n" +
        "from otherFsm.v02.generated_registry import ACTOR_REGISTRATIONS as otherfsm_v02\n" +
        "\n" +
        "ACTOR_REGISTRATIONS = [\n" +
        "    *creditcheck_v01,\n" +
        "    *otherfsm_v02,\n" +
        "]\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeAggregateActorsRegistry - rust #[path]-includes each FSM-version's actor barrel under a unique alias", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = await writeAggregateActorsRegistry(
      dir,
      actorsForAggregateTests,
      "rust",
    );
    assertEquals(
      file,
      `${dir}/async-worker/rust/rust-actors-registry.generated.rs`,
    );
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        '#[path = "./creditCheck/v01/actors/mod.rs"]\n' +
        "mod creditcheck_v01;\n" +
        "\n" +
        '#[path = "./otherFsm/v02/actors/mod.rs"]\n' +
        "mod otherfsm_v02;\n" +
        "\n" +
        "pub struct ActorRegistration {\n" +
        "    pub parent_fsm_name: &'static str,\n" +
        "    pub parent_fsm_version: &'static str,\n" +
        "    pub async_operation_type: &'static str,\n" +
        "    pub async_operation_name: &'static str,\n" +
        "    pub async_operation_version: &'static str,\n" +
        "    pub async_operation_language: &'static str,\n" +
        "    pub handler: fn(serde_json::Value) -> serde_json::Value,\n" +
        "}\n" +
        "\n" +
        "pub fn actor_registrations() -> Vec<ActorRegistration> {\n" +
        "    vec![\n" +
        "        ActorRegistration {\n" +
        '            parent_fsm_name: "creditCheck",\n' +
        '            parent_fsm_version: "v01",\n' +
        '            async_operation_type: "internalAsyncOperation",\n' +
        '            async_operation_name: "checkBureau",\n' +
        '            async_operation_version: "v01",\n' +
        '            async_operation_language: "rust",\n' +
        "            handler: creditcheck_v01::checkBureau,\n" +
        "        },\n" +
        "        ActorRegistration {\n" +
        '            parent_fsm_name: "otherFsm",\n' +
        '            parent_fsm_version: "v02",\n' +
        '            async_operation_type: "internalAsyncOperation",\n' +
        '            async_operation_name: "someActorRs",\n' +
        '            async_operation_version: "v02",\n' +
        '            async_operation_language: "rust",\n' +
        "            handler: otherfsm_v02::someActorRs,\n" +
        "        },\n" +
        "    ]\n" +
        "}\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeAggregateActorsRegistry - writes nothing when there are no actors for that language", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actors: RegisteredActor[] = [
      toRegisteredActor(CREDIT_CHECK_V01, "python", {
        src: "checkBureauPython",
      }),
    ];
    const file = await writeAggregateActorsRegistry(
      dir,
      actors,
      "typescript",
    );
    assertEquals(file, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const actorsForGoAggregateTests: RegisteredActor[] = [
  toRegisteredActor(CREDIT_CHECK_V01, "go", { src: "checkBureau" }),
  toRegisteredActor(OTHER_FSM_V02, "go", { src: "someActor" }),
];

Deno.test("writeAggregateGoRegistry - writes a standalone Go module with one require+replace and import per actor", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const file = await writeAggregateGoRegistry(
      appRootAbsPath,
      "fsm-core-example",
      actorsForGoAggregateTests,
    );
    assertEquals(
      file,
      `${appRootAbsPath}/async-worker/go/go-actors-registry-generated/registry.go`,
    );
    const registryContent = await Deno.readTextFile(file!);
    assertEquals(
      registryContent,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        "package generatedregistry\n" +
        "\n" +
        "import (\n" +
        '\tcreditcheck_v01_checkbureau "fsm-core-example/creditcheck/v01/go/actors/checkbureau"\n' +
        '\totherfsm_v02_someactor "fsm-core-example/otherfsm/v02/go/actors/someactor"\n' +
        ")\n" +
        "\n" +
        "type ActorRegistration struct {\n" +
        "\tParentFsmName    string\n" +
        "\tParentFsmVersion string\n" +
        "\tAsyncOperationType          string\n" +
        "\tAsyncOperationName          string\n" +
        "\tAsyncOperationVersion       string\n" +
        "\tAsyncOperationLanguage      string\n" +
        "\tHandler          func(input any) (any, error)\n" +
        "}\n" +
        "\n" +
        "func ActorRegistrations() []ActorRegistration {\n" +
        "\treturn []ActorRegistration{\n" +
        "\t\t{\n" +
        '\t\t\tParentFsmName:    "creditCheck",\n' +
        '\t\t\tParentFsmVersion: "v01",\n' +
        '\t\t\tAsyncOperationType:          "internalAsyncOperation",\n' +
        '\t\t\tAsyncOperationName:          "checkBureau",\n' +
        '\t\t\tAsyncOperationVersion:       "v01",\n' +
        '\t\t\tAsyncOperationLanguage:      "go",\n' +
        "\t\t\tHandler:          creditcheck_v01_checkbureau.CheckBureau,\n" +
        "\t\t},\n" +
        "\t\t{\n" +
        '\t\t\tParentFsmName:    "otherFsm",\n' +
        '\t\t\tParentFsmVersion: "v02",\n' +
        '\t\t\tAsyncOperationType:          "internalAsyncOperation",\n' +
        '\t\t\tAsyncOperationName:          "someActor",\n' +
        '\t\t\tAsyncOperationVersion:       "v02",\n' +
        '\t\t\tAsyncOperationLanguage:      "go",\n' +
        "\t\t\tHandler:          otherfsm_v02_someactor.SomeActor,\n" +
        "\t\t},\n" +
        "\t}\n" +
        "}\n",
    );
    const goModContent = await Deno.readTextFile(
      `${appRootAbsPath}/async-worker/go/go-actors-registry-generated/go.mod`,
    );
    assertEquals(
      goModContent,
      "module fsm-core-example/go-actors-registry-generated\n" +
        "\n" +
        "go 1.19\n" +
        "\n" +
        "require fsm-core-example/creditcheck/v01/go/actors/checkbureau v0.0.0\n" +
        "require fsm-core-example/otherfsm/v02/go/actors/someactor v0.0.0\n" +
        "\n" +
        "replace fsm-core-example/creditcheck/v01/go/actors/checkbureau => ../creditCheck/v01/actors/checkBureau\n" +
        "replace fsm-core-example/otherfsm/v02/go/actors/someactor => ../otherFsm/v02/actors/someActor\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeAggregateGoRegistry - writes nothing when there are no go actors", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actors: RegisteredActor[] = [
      toRegisteredActor(CREDIT_CHECK_V01, "typescript", { src: "checkBureau" }),
    ];
    const file = await writeAggregateGoRegistry(
      dir,
      "fsm-core-example",
      actors,
    );
    assertEquals(file, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWorkerSdk - writes cli/main+sdk+manifest per language, only for languages with actors", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const actors = [
      ...actorsForBarrelTests, // typescript, python, rust
      ...actorsForGoAggregateTests, // go
    ];
    const base = `${appRootAbsPath}/async-worker`;
    const wrote = await writeWorkerSdk(
      appRootAbsPath,
      "fsm-core-example",
      `${appRootAbsPath}/fsm`,
      actors,
    );
    assertEquals(wrote, {
      typescript: true,
      python: true,
      rust: true,
      go: true,
      tsFiles: [`${base}/typescript/run-async-worker.ts`],
      rustFiles: [`${base}/rust/src/main.rs`],
      goFiles: [`${base}/go/sdk.go`],
      goModDir: `${base}/go`,
    });
    assertExists(await Deno.stat(`${base}/typescript/run-async-worker.ts`));
    assertExists(await Deno.stat(`${base}/typescript/deno.json`));
    assertExists(await Deno.stat(`${base}/python/run_async_worker.py`));
    assertExists(await Deno.stat(`${base}/python/pyproject.toml`));
    assertExists(await Deno.stat(`${base}/rust/src/main.rs`));
    assertExists(await Deno.stat(`${base}/rust/Cargo.toml`));
    assertExists(await Deno.stat(`${base}/rust/.gitignore`));
    assertExists(await Deno.stat(`${base}/go/main.go`));
    assertExists(await Deno.stat(`${base}/go/sdk.go`));
    assertExists(await Deno.stat(`${base}/go/go.mod`));
    assertExists(await Deno.stat(`${base}/go/.gitignore`));

    const tsRun = await Deno.readTextFile(
      `${base}/typescript/run-async-worker.ts`,
    );
    assertEquals(
      tsRun.includes(
        'import { ACTOR_REGISTRATIONS } from "./typescript-actors-registry.generated.ts";',
      ),
      true,
    );
    assertEquals(
      tsRun.includes(
        'import { runActorWorkerCli } from "@pgfsm/async-worker-sdk";',
      ),
      true,
    );

    // Every bare specifier run-async-worker.ts imports must be declared here
    // -- nothing else in the generated project provides an import map.
    const tsDenoJson = JSON.parse(
      await Deno.readTextFile(`${base}/typescript/deno.json`),
    );
    assertEquals(tsDenoJson.imports, {
      "@pgfsm/async-worker-sdk": "npm:@pgfsm/async-worker-sdk@^0.1.0",
      "@pgfsm/logging": "npm:@pgfsm/logging@^0.1.0",
    });

    const pyRun = await Deno.readTextFile(`${base}/python/run_async_worker.py`);
    assertEquals(
      pyRun.includes(
        "from python_actors_registry_generated import ACTOR_REGISTRATIONS",
      ),
      true,
    );
    assertEquals(
      pyRun.includes(
        "from pgfsm.async_worker_sdk import run_actor_worker_cli",
      ),
      true,
    );

    // run_async_worker.py's only third-party import comes from this pin.
    const pyproject = await Deno.readTextFile(`${base}/python/pyproject.toml`);
    assertEquals(
      pyproject.includes('"pgfsm-async-worker-sdk>=0.1.0,<0.2",'),
      true,
    );

    const rustMain = await Deno.readTextFile(`${base}/rust/src/main.rs`);
    assertEquals(
      rustMain.includes(
        '#[path = "../rust-actors-registry.generated.rs"]',
      ),
      true,
    );
    assertEquals(
      rustMain.includes(
        "use pgfsm_async_worker_sdk::{run_actor_worker_cli, ActorRegistration};",
      ),
      true,
    );

    // main.rs's only external crates come from these; no monorepo `path =`
    // dependency (the SDK and its proto stubs come from crates.io).
    const cargoToml = await Deno.readTextFile(`${base}/rust/Cargo.toml`);
    assertEquals(cargoToml.includes('pgfsm-async-worker-sdk = "0.1"'), true);
    assertEquals(cargoToml.includes('serde_json = "1"'), true);
    assertEquals(cargoToml.includes('env_logger = "0.11"'), true);
    assertEquals(cargoToml.includes("{ path ="), false);
    assertEquals(cargoToml.includes("pgfsm-proto-codegen"), false);

    const goMod = await Deno.readTextFile(`${base}/go/go.mod`);
    assertEquals(
      goMod,
      "module pgfsm/async-op-worker-sdk\n\ngo 1.19\n\n" +
        "require fsm-core-example/go-actors-registry-generated v0.0.0\n" +
        "require fsm-core-example/creditcheck/v01/go/actors/checkbureau v0.0.0\n" +
        "require fsm-core-example/otherfsm/v02/go/actors/someactor v0.0.0\n" +
        "require github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go v0.0.0\n\n" +
        "replace fsm-core-example/go-actors-registry-generated => ./go-actors-registry-generated\n" +
        "replace fsm-core-example/creditcheck/v01/go/actors/checkbureau => ./creditCheck/v01/actors/checkBureau\n" +
        "replace fsm-core-example/otherfsm/v02/go/actors/someactor => ./otherFsm/v02/actors/someActor\n" +
        "replace github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go => ../../../../packages/fsm-proto-codegen/gen/go\n",
    );

    for (
      const [file, header] of [
        [`${base}/typescript/run-async-worker.ts`, "// AUTO-GENERATED"],
        // run_async_worker.py's shebang must stay on line 1 to remain
        // executable -- the header is the second line there, not the first.
        [
          `${base}/python/run_async_worker.py`,
          "#!/usr/bin/env python3\n# AUTO-GENERATED",
        ],
        [`${base}/python/pyproject.toml`, "# AUTO-GENERATED"],
        [`${base}/rust/src/main.rs`, "// AUTO-GENERATED"],
        [`${base}/rust/Cargo.toml`, "# AUTO-GENERATED"],
        [`${base}/go/main.go`, "// AUTO-GENERATED"],
        [`${base}/go/sdk.go`, "// AUTO-GENERATED"],
      ] as const
    ) {
      const content = await Deno.readTextFile(file);
      assertEquals(
        content.startsWith(header),
        true,
        `${file} should start with ${header}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWorkerSdk - removes a stale pre-#358 generated cli.ts/sdk.ts, keeps a hand-edited one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const tsDir = `${appRootAbsPath}/async-worker/typescript`;
    await Deno.mkdir(tsDir, { recursive: true });
    await Deno.writeTextFile(
      `${tsDir}/sdk.ts`,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n",
    );
    await Deno.writeTextFile(`${tsDir}/cli.ts`, "// my own worker entry\n");

    await writeWorkerSdk(
      appRootAbsPath,
      "fsm-core-example",
      `${appRootAbsPath}/fsm`,
      [toRegisteredActor(CREDIT_CHECK_V01, "typescript", {
        src: "checkBureau",
      })],
    );

    let sdkErr: unknown;
    try {
      await Deno.stat(`${tsDir}/sdk.ts`);
    } catch (err) {
      sdkErr = err;
    }
    assertExists(sdkErr, "generated sdk.ts should have been removed");
    assertEquals(
      await Deno.readTextFile(`${tsDir}/cli.ts`),
      "// my own worker entry\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWorkerSdk - removes a stale pre-#364 generated cli.py/sdk.py/requirements.txt, keeps a hand-edited one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const pyDir = `${appRootAbsPath}/async-worker/python`;
    await Deno.mkdir(pyDir, { recursive: true });
    await Deno.writeTextFile(
      `${pyDir}/cli.py`,
      "#!/usr/bin/env python3\n# AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n",
    );
    await Deno.writeTextFile(
      `${pyDir}/requirements.txt`,
      "# AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n",
    );
    await Deno.writeTextFile(`${pyDir}/sdk.py`, "# my own sdk\n");

    await writeWorkerSdk(
      appRootAbsPath,
      "fsm-core-example",
      `${appRootAbsPath}/fsm`,
      [toRegisteredActor(CREDIT_CHECK_V01, "python", { src: "checkBureau" })],
    );

    for (const file of ["cli.py", "requirements.txt"]) {
      let statErr: unknown;
      try {
        await Deno.stat(`${pyDir}/${file}`);
      } catch (err) {
        statErr = err;
      }
      assertExists(statErr, `generated ${file} should have been removed`);
    }
    assertEquals(
      await Deno.readTextFile(`${pyDir}/sdk.py`),
      "# my own sdk\n",
    );
    assertExists(await Deno.stat(`${pyDir}/run_async_worker.py`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWorkerSdk - removes a stale pre-#368 generated src/sdk.rs, keeps a hand-edited one", async () => {
  for (const handEdited of [false, true]) {
    const dir = await Deno.makeTempDir();
    try {
      const appRootAbsPath = `${dir}/apps/fsm-core-example`;
      const rustDir = `${appRootAbsPath}/async-worker/rust`;
      await Deno.mkdir(`${rustDir}/src`, { recursive: true });
      const content = handEdited
        ? "// my own sdk\n"
        : "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n";
      await Deno.writeTextFile(`${rustDir}/src/sdk.rs`, content);

      await writeWorkerSdk(
        appRootAbsPath,
        "fsm-core-example",
        `${appRootAbsPath}/fsm`,
        [toRegisteredActor(CREDIT_CHECK_V01, "rust", { src: "checkBureau" })],
      );

      if (handEdited) {
        assertEquals(
          await Deno.readTextFile(`${rustDir}/src/sdk.rs`),
          "// my own sdk\n",
        );
      } else {
        let statErr: unknown;
        try {
          await Deno.stat(`${rustDir}/src/sdk.rs`);
        } catch (err) {
          statErr = err;
        }
        assertExists(statErr, "generated src/sdk.rs should have been removed");
      }
      assertExists(await Deno.stat(`${rustDir}/src/main.rs`));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("writeWorkerSdk - writes nothing for a language with no actors", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const actors = [
      toRegisteredActor(CREDIT_CHECK_V01, "typescript", { src: "checkBureau" }),
    ];
    const base = `${appRootAbsPath}/async-worker`;
    const wrote = await writeWorkerSdk(
      appRootAbsPath,
      "fsm-core-example",
      `${appRootAbsPath}/fsm`,
      actors,
    );
    assertEquals(wrote, {
      typescript: true,
      python: false,
      rust: false,
      go: false,
      tsFiles: [`${base}/typescript/run-async-worker.ts`],
      rustFiles: [],
      goFiles: [],
      goModDir: undefined,
    });
    assertExists(await Deno.stat(`${base}/typescript/deno.json`));

    let existsErr: unknown;
    try {
      await Deno.stat(`${appRootAbsPath}/async-worker/python`);
    } catch (err) {
      existsErr = err;
    }
    assertExists(existsErr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
