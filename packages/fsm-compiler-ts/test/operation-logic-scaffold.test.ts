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
  writeSyncOperationRegistry,
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
    filePath: "typescript/actors/checkBureau/checkBureau.ts",
    exportedName: "checkBureau",
  });
});

Deno.test("toWrittenActor - go capitalizes exportedName for cross-package export, src is untouched", () => {
  const actor: ActorReference = { src: "checkBureau" };
  assertEquals(toWrittenActor("go", actor), {
    src: "checkBureau",
    fileBaseName: "checkBureau",
    asyncOperationLanguage: "go",
    filePath: "go/actors/checkBureau/checkBureau.go",
    exportedName: "CheckBureau",
  });
});

Deno.test("writeActorsManifest - writes all actors across all languages", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const actors: WrittenActor[] = [
      toWrittenActor("typescript", { src: "checkBureau" }),
      toWrittenActor("python", { src: "checkBureauPython" }),
      toWrittenActor("go", { src: "checkBureauGo" }),
    ];
    const file = await writeActorsManifest(dir, actors);
    assertEquals(file, `${dir}/actors-manifest.json`);
    const manifest = JSON.parse(await Deno.readTextFile(file));
    assertEquals(manifest, {
      actors: [
        {
          src: "checkBureau",
          asyncOperationLanguage: "typescript",
          filePath: "typescript/actors/checkBureau/checkBureau.ts",
          exportedName: "checkBureau",
        },
        {
          src: "checkBureauPython",
          asyncOperationLanguage: "python",
          filePath: "python/actors/checkBureauPython/checkBureauPython.py",
          exportedName: "checkBureauPython",
        },
        {
          src: "checkBureauGo",
          asyncOperationLanguage: "go",
          filePath: "go/actors/checkBureauGo/checkBureauGo.go",
          exportedName: "CheckBureauGo",
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
    assertEquals(file, `${dir}/typescript/actors/generated-registry.ts`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        'import { checkBureau } from "./checkBureau/checkBureau.ts";\n' +
        'import { determineMiddleScore } from "./determineMiddleScore/determineMiddleScore.ts";\n' +
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
    assertEquals(file, `${dir}/python/actors/generated_registry.py`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "# AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        "from .checkBureauPython.checkBureauPython import checkBureauPython\n" +
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
    assertEquals(file, `${dir}/rust/actors/generated_registry.rs`);
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        '#[path = "mod.rs"]\n' +
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
      `${dir}/fsm`,
      actorsForAggregateTests,
      "typescript",
    );
    assertEquals(
      file,
      `${dir}/worker-sdk-generated/typescript/typescript-actors-registry.generated.ts`,
    );
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        'import { ACTOR_REGISTRATIONS as creditcheck_v01 } from "../../fsm/creditCheck/v01/typescript/actors/generated-registry.ts";\n' +
        'import { ACTOR_REGISTRATIONS as otherfsm_v02 } from "../../fsm/otherFsm/v02/typescript/actors/generated-registry.ts";\n' +
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
      `${dir}/fsm`,
      actorsForAggregateTests,
      "python",
    );
    assertEquals(
      file,
      `${dir}/worker-sdk-generated/python/python_actors_registry_generated.py`,
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
        "# equivalent for a sibling directory two levels up.\n" +
        "import os\n" +
        "import sys\n" +
        "\n" +
        "_PLUGIN_ROOT = os.path.abspath(\n" +
        '    os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../fsm")\n' +
        ")\n" +
        "if _PLUGIN_ROOT not in sys.path:\n" +
        "    sys.path.insert(0, _PLUGIN_ROOT)\n" +
        "\n" +
        "from creditCheck.v01.python.actors.generated_registry import ACTOR_REGISTRATIONS as creditcheck_v01\n" +
        "from otherFsm.v02.python.actors.generated_registry import ACTOR_REGISTRATIONS as otherfsm_v02\n" +
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
      `${dir}/fsm`,
      actorsForAggregateTests,
      "rust",
    );
    assertEquals(
      file,
      `${dir}/worker-sdk-generated/rust/rust-actors-registry.generated.rs`,
    );
    const content = await Deno.readTextFile(file!);
    assertEquals(
      content,
      "// AUTO-GENERATED by fsm-compiler-ts. Do not edit directly.\n" +
        '#[path = "../../fsm/creditCheck/v01/rust/actors/mod.rs"]\n' +
        "mod creditcheck_v01;\n" +
        "\n" +
        '#[path = "../../fsm/otherFsm/v02/rust/actors/mod.rs"]\n' +
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
      `${dir}/fsm`,
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
      `${appRootAbsPath}/fsm`,
      actorsForGoAggregateTests,
    );
    assertEquals(
      file,
      `${appRootAbsPath}/worker-sdk-generated/go/go-actors-registry-generated/registry.go`,
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
      `${appRootAbsPath}/worker-sdk-generated/go/go-actors-registry-generated/go.mod`,
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
        "replace fsm-core-example/creditcheck/v01/go/actors/checkbureau => ../../../fsm/creditCheck/v01/go/actors/checkBureau\n" +
        "replace fsm-core-example/otherfsm/v02/go/actors/someactor => ../../../fsm/otherFsm/v02/go/actors/someActor\n",
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
      `${dir}/fsm`,
      actors,
    );
    assertEquals(file, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWorkerSdk - writes cli/main+sdk+protocol+manifest per language, only for languages with actors", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const actors = [
      ...actorsForBarrelTests, // typescript, python, rust
      ...actorsForGoAggregateTests, // go
    ];
    const base = `${appRootAbsPath}/worker-sdk-generated`;
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
      tsFiles: [`${base}/typescript/cli.ts`, `${base}/typescript/sdk.ts`],
      rustFiles: [`${base}/rust/src/main.rs`, `${base}/rust/src/sdk.rs`],
      goFiles: [`${base}/go/sdk.go`],
      goModDir: `${base}/go`,
    });
    assertExists(await Deno.stat(`${base}/typescript/cli.ts`));
    assertExists(await Deno.stat(`${base}/typescript/sdk.ts`));
    assertExists(await Deno.stat(`${base}/python/cli.py`));
    assertExists(await Deno.stat(`${base}/python/sdk.py`));
    assertExists(await Deno.stat(`${base}/python/requirements.txt`));
    assertExists(await Deno.stat(`${base}/rust/src/main.rs`));
    assertExists(await Deno.stat(`${base}/rust/src/sdk.rs`));
    assertExists(await Deno.stat(`${base}/rust/Cargo.toml`));
    assertExists(await Deno.stat(`${base}/rust/.gitignore`));
    assertExists(await Deno.stat(`${base}/go/main.go`));
    assertExists(await Deno.stat(`${base}/go/sdk.go`));
    assertExists(await Deno.stat(`${base}/go/go.mod`));
    assertExists(await Deno.stat(`${base}/go/.gitignore`));

    const tsCli = await Deno.readTextFile(`${base}/typescript/cli.ts`);
    assertEquals(
      tsCli.includes(
        'import { ACTOR_REGISTRATIONS } from "./typescript-actors-registry.generated.ts";',
      ),
      true,
    );

    const tsSdk = await Deno.readTextFile(`${base}/typescript/sdk.ts`);
    assertEquals(
      tsSdk.includes(
        'from "@pgfsm/proto-codegen/sidecargateway/v1/connect";',
      ),
      true,
    );
    assertEquals(
      tsSdk.includes(
        'from "@pgfsm/proto-codegen/sidecargateway/v1/pb";',
      ),
      true,
    );

    const pyCli = await Deno.readTextFile(`${base}/python/cli.py`);
    assertEquals(
      pyCli.includes(
        "from python_actors_registry_generated import ACTOR_REGISTRATIONS",
      ),
      true,
    );

    const rustMain = await Deno.readTextFile(`${base}/rust/src/main.rs`);
    assertEquals(
      rustMain.includes(
        '#[path = "../rust-actors-registry.generated.rs"]',
      ),
      true,
    );

    const goMod = await Deno.readTextFile(`${base}/go/go.mod`);
    assertEquals(
      goMod,
      "module pgfsm/async-op-worker-sdk\n\ngo 1.19\n\n" +
        "require fsm-core-example/go-actors-registry-generated v0.0.0\n" +
        "require fsm-core-example/creditcheck/v01/go/actors/checkbureau v0.0.0\n" +
        "require fsm-core-example/otherfsm/v02/go/actors/someactor v0.0.0\n" +
        "require github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go v0.0.0\n\n" +
        "replace fsm-core-example/go-actors-registry-generated => ./go-actors-registry-generated\n" +
        "replace fsm-core-example/creditcheck/v01/go/actors/checkbureau => ../../fsm/creditCheck/v01/go/actors/checkBureau\n" +
        "replace fsm-core-example/otherfsm/v02/go/actors/someactor => ../../fsm/otherFsm/v02/go/actors/someActor\n" +
        "replace github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go => ../../../../packages/fsm-proto-codegen/gen/go\n",
    );

    for (
      const [file, header] of [
        [`${base}/typescript/cli.ts`, "// AUTO-GENERATED"],
        [`${base}/typescript/sdk.ts`, "// AUTO-GENERATED"],
        // cli.py's shebang must stay on line 1 to remain executable -- the
        // header is the second line there, not the first.
        [`${base}/python/cli.py`, "#!/usr/bin/env python3\n# AUTO-GENERATED"],
        [`${base}/python/sdk.py`, "# AUTO-GENERATED"],
        [`${base}/rust/src/main.rs`, "// AUTO-GENERATED"],
        [`${base}/rust/src/sdk.rs`, "// AUTO-GENERATED"],
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

Deno.test('writeWorkerSdk - protocol: "legacy" restores protocol.{py,rs,go} and the pre-#100 sdk imports', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const actors = [
      ...actorsForBarrelTests, // typescript, python, rust
      ...actorsForGoAggregateTests, // go
    ];
    const base = `${appRootAbsPath}/worker-sdk-generated`;
    const wrote = await writeWorkerSdk(
      appRootAbsPath,
      "fsm-core-example",
      `${appRootAbsPath}/fsm`,
      actors,
      {
        protocol: "legacy",
      },
    );
    assertEquals(wrote, {
      typescript: true,
      python: true,
      rust: true,
      go: true,
      tsFiles: [`${base}/typescript/cli.ts`, `${base}/typescript/sdk.ts`],
      rustFiles: [`${base}/rust/src/main.rs`, `${base}/rust/src/sdk.rs`],
      goFiles: [`${base}/go/sdk.go`],
      goModDir: `${base}/go`,
    });
    assertExists(await Deno.stat(`${base}/python/protocol.py`));
    assertExists(await Deno.stat(`${base}/rust/src/protocol.rs`));
    assertExists(await Deno.stat(`${base}/go/protocol.go`));

    const tsSdk = await Deno.readTextFile(`${base}/typescript/sdk.ts`);
    assertEquals(
      tsSdk.includes(
        'from "../../../../packages/fsm-core-async-op-worker/src/sidecar/protocol.ts";',
      ),
      true,
    );

    const pySdk = await Deno.readTextFile(`${base}/python/sdk.py`);
    assertEquals(
      pySdk.includes("from protocol import actor_key, make_envelope"),
      true,
    );

    const rustSdk = await Deno.readTextFile(`${base}/rust/src/sdk.rs`);
    assertEquals(
      rustSdk.includes("use crate::protocol::"),
      true,
    );

    const goMod = await Deno.readTextFile(`${base}/go/go.mod`);
    assertEquals(
      goMod.includes("fsm-proto-codegen"),
      false,
      "legacy go.mod should not require the generated proto module",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeWorkerSdk - writes nothing for a language with no actors", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const appRootAbsPath = `${dir}/apps/fsm-core-example`;
    const actors = [
      toRegisteredActor(CREDIT_CHECK_V01, "typescript", { src: "checkBureau" }),
    ];
    const base = `${appRootAbsPath}/worker-sdk-generated`;
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
      tsFiles: [`${base}/typescript/cli.ts`, `${base}/typescript/sdk.ts`],
      rustFiles: [],
      goFiles: [],
      goModDir: undefined,
    });

    let existsErr: unknown;
    try {
      await Deno.stat(`${appRootAbsPath}/worker-sdk-generated/python`);
    } catch (err) {
      existsErr = err;
    }
    assertExists(existsErr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
