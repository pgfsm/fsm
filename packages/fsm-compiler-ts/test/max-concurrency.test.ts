// Per-actor maxConcurrency (#435): every new actor stub declares it, the
// registries pass it on when the stub (new or kept) declares it, and leave it
// unset when a stub kept from before #435 doesn't -- referencing a missing
// name wouldn't compile (Rust, Go) or import (TypeScript, Python).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  stubDeclaresMaxConcurrency,
  toRegisteredActor,
  writeActorFile,
  writeActorsRegistry,
  writeAggregateActorsRegistry,
  writeAggregateGoRegistry,
  writeWorkerSdk,
} from "../src/operation-logic-scaffold.ts";
import { type FileWriteEvent, withWritePolicy } from "../src/write-policy.ts";
import type { OperationLang } from "../src/types/index.ts";

const VERSION_FOLDER = "/plugin/fsm/creditCheck/v01";
const EXT: Record<OperationLang, string> = {
  typescript: "ts",
  python: "py",
  rust: "rs",
  go: "go",
};

/** A stub as written before #435: the handler only, no setting. */
const LEGACY_STUB: Record<OperationLang, string> = {
  typescript:
    "export function oldActor(input: unknown): unknown {\n  return input;\n}\n",
  python: "def oldActor(input):\n    return input\n",
  rust:
    "#[allow(non_snake_case)]\npub fn oldActor(input: serde_json::Value) -> serde_json::Value {\n    input\n}\n",
  go:
    "package actors\n\nfunc OldActor(input any) (any, error) {\n\treturn input, nil\n}\n",
};

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeFile(path: string, content: string) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, content);
}

Deno.test("a new actor stub declares its own max concurrency, in every language", async () => {
  await withTempDir(async (dir) => {
    for (const lang of ["typescript", "python", "rust", "go"] as const) {
      const file = await writeActorFile(dir, lang, { src: "checkBureau" });
      const content = await Deno.readTextFile(file);
      assert(
        await stubDeclaresMaxConcurrency(file, lang),
        `${lang} stub doesn't declare it:\n${content}`,
      );
      // The comment states both requirements it brings.
      assertStringIncludes(content, "idempotent");
      assertStringIncludes(content, "at once");
    }
  });
});

Deno.test("stubDeclaresMaxConcurrency matches real declarations only", async () => {
  const cases: [OperationLang, string, boolean][] = [
    ["typescript", "export const maxConcurrency = 4;\n", true],
    ["typescript", "// export const maxConcurrency = 4;\n", false],
    ["typescript", "const maxConcurrency = 4;\n", false], // not exported
    ["python", "MAX_CONCURRENCY = 4\n", true],
    ["python", "MAX_CONCURRENCY: int = 4\n", true],
    ["python", "# MAX_CONCURRENCY = 4\n", false],
    ["python", "def f():\n    MAX_CONCURRENCY = 4\n", false], // a local
    ["rust", "pub const MAX_CONCURRENCY: usize = 4;\n", true],
    ["rust", "const MAX_CONCURRENCY: u32 = 4;\n", false], // not pub
    ["rust", "// pub const MAX_CONCURRENCY: u32 = 4;\n", false],
    ["go", "const MaxConcurrency = 4\n", true],
    ["go", "const MaxConcurrency int = 4\n", true],
    ["go", "const (\n\tMaxConcurrency = 4\n)\n", true],
    ["go", "// const MaxConcurrency = 4\n", false],
    ["go", "func f() { maxConcurrency := 4 }\n", false],
  ];
  await withTempDir(async (dir) => {
    for (const [i, [lang, content, expected]] of cases.entries()) {
      const file = `${dir}/stub${i}.${EXT[lang]}`;
      await Deno.writeTextFile(file, content);
      assertEquals(
        await stubDeclaresMaxConcurrency(file, lang),
        expected,
        `${lang}: ${JSON.stringify(content)}`,
      );
    }
    assertEquals(
      await stubDeclaresMaxConcurrency(`${dir}/missing.ts`, "typescript"),
      false,
    );
  });
});

Deno.test("a per-version registry passes on a declared setting and leaves a kept legacy stub's unset", async () => {
  const expected: Record<"typescript" | "python" | "rust", {
    declared: string[];
    legacy: string;
  }> = {
    typescript: {
      declared: [
        "maxConcurrency as maxConcurrency_checkBureau",
        "maxConcurrency: maxConcurrency_checkBureau,",
      ],
      legacy: "maxConcurrency_oldActor",
    },
    python: {
      declared: [
        "MAX_CONCURRENCY as _max_concurrency_checkBureau",
        '"max_concurrency": _max_concurrency_checkBureau,',
      ],
      legacy: "_max_concurrency_oldActor",
    },
    rust: {
      declared: [
        "max_concurrency: actors::checkBureau::MAX_CONCURRENCY as u32,",
      ],
      legacy: "actors::oldActor::MAX_CONCURRENCY",
    },
  };
  for (const lang of ["typescript", "python", "rust"] as const) {
    await withTempDir(async (dir) => {
      await writeActorFile(dir, lang, { src: "checkBureau" });
      await writeFile(
        `${dir}/${lang}/actors/oldActor/oldActor.${EXT[lang]}`,
        LEGACY_STUB[lang],
      );
      const file = await writeActorsRegistry(dir, [
        toRegisteredActor(VERSION_FOLDER, lang, { src: "checkBureau" }),
        toRegisteredActor(VERSION_FOLDER, lang, { src: "oldActor" }),
      ], lang);
      const content = await Deno.readTextFile(file!);
      for (const line of expected[lang].declared) {
        assertStringIncludes(content, line, lang);
      }
      assertEquals(content.includes(expected[lang].legacy), false, lang);
      if (lang === "rust") {
        // The legacy actor still gets the field, as "unset".
        assertStringIncludes(content, "max_concurrency: 0,");
      }
    });
  }
});

Deno.test("the Rust aggregate reaches each declared setting through the barrel", async () => {
  await withTempDir(async (dir) => {
    const actor = toRegisteredActor(VERSION_FOLDER, "rust", {
      src: "checkBureau",
    });
    await writeActorFile(
      `${dir}/async-worker`,
      "rust",
      { src: "checkBureau" },
      undefined,
      "creditCheck/v01",
    );
    const file = await writeAggregateActorsRegistry(dir, [actor], "rust");
    assertStringIncludes(
      await Deno.readTextFile(file!),
      "max_concurrency: creditcheck_v01::checkBureau::MAX_CONCURRENCY as u32,",
    );
  });
});

Deno.test("the Go registry passes on a declared setting and skips a kept legacy stub", async () => {
  await withTempDir(async (dir) => {
    const declared = toRegisteredActor(VERSION_FOLDER, "go", {
      src: "checkBureau",
    });
    const legacy = toRegisteredActor(VERSION_FOLDER, "go", { src: "oldActor" });
    await writeActorFile(
      `${dir}/async-worker`,
      "go",
      { src: "checkBureau" },
      "app",
      "creditCheck/v01",
    );
    await writeFile(
      `${dir}/async-worker/go/creditCheck/v01/actors/oldActor/oldActor.go`,
      LEGACY_STUB.go,
    );
    const file = await writeAggregateGoRegistry(dir, "app", [
      declared,
      legacy,
    ]);
    const content = await Deno.readTextFile(file!);
    assertStringIncludes(
      content,
      "uint32(creditcheck_v01_checkbureau.MaxConcurrency)",
    );
    assertEquals(
      content.includes("creditcheck_v01_oldactor.MaxConcurrency"),
      false,
    );
  });
});

Deno.test("the worker entry points pass each actor's setting to the SDK", async () => {
  await withTempDir(async (dir) => {
    await writeWorkerSdk(dir, "app", [
      toRegisteredActor(VERSION_FOLDER, "rust", { src: "checkBureau" }),
      toRegisteredActor(VERSION_FOLDER, "go", { src: "checkBureau" }),
    ]);
    assertStringIncludes(
      await Deno.readTextFile(`${dir}/async-worker/rust/src/main.rs`),
      ".with_max_concurrency(reg.max_concurrency)",
    );
    assertStringIncludes(
      await Deno.readTextFile(`${dir}/async-worker/go/main.go`),
      ".WithMaxConcurrency(reg.MaxConcurrency)",
    );
  });
});

Deno.test("a kept Rust main.rs that doesn't pass the setting on is reported", async () => {
  await withTempDir(async (dir) => {
    const mainRs = `${dir}/async-worker/rust/src/main.rs`;
    await writeFile(mainRs, "fn main() {}\n");
    const events: FileWriteEvent[] = [];
    await withWritePolicy(
      { overwrite: "generated-only", onFileWrite: (e) => events.push(e) },
      () =>
        writeWorkerSdk(dir, "app", [
          toRegisteredActor(VERSION_FOLDER, "rust", { src: "checkBureau" }),
        ]),
    );
    const event = events.find((e) => e.path === mainRs);
    assertEquals(event?.action, "kept");
    assertEquals(event?.missingNames, ["with_max_concurrency"]);
    assertEquals(await Deno.readTextFile(mainRs), "fn main() {}\n");
  });
});
