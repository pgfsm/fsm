import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createAsyncOperationLogic } from "../src/create-async-logic.ts";

Deno.test("createAsyncOperationLogic - writes a single actor under <appRoot>/async-worker/<lang>/shared-async-op/<functionVersion>/actors/<functionName>/<functionVersion>/<functionName>.<ext>", async () => {
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
      `${dir}/async-worker/typescript/shared-async-op/v01/actors/checkCreditScore/v01/checkCreditScore.ts`,
    );
    const content = await Deno.readTextFile(file);
    assertEquals(
      content,
      '// Actor: checkCreditScore\nexport function checkCreditScore(input: unknown): unknown {\n  // TODO: implement actor logic\n  return { input, msg: "checkCreditScore actor invoked by typescript" };\n}\n',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - writes a global generated-registry.ts entry with the fixed sharedAsyncOperation identity", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    const registryContent = await Deno.readTextFile(
      `${dir}/async-worker/typescript/shared-async-op/generated-registry.ts`,
    );
    assertStringIncludes(
      registryContent,
      'import { checkCreditScore as checkCreditScore_v01 } from "./v01/actors/checkCreditScore/v01/checkCreditScore.ts";',
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

Deno.test("createAsyncOperationLogic - a second call accumulates in the global registry instead of clobbering the first", async () => {
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
      `${dir}/async-worker/typescript/shared-async-op/generated-registry.ts`,
    );
    assertStringIncludes(registryContent, "handler: checkCreditScore_v01,");
    assertStringIncludes(registryContent, "handler: verifyIdentity_v01,");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - a second call with a different function-version accumulates without alias collision", async () => {
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
    const registryContent = await Deno.readTextFile(
      `${dir}/async-worker/typescript/shared-async-op/generated-registry.ts`,
    );
    assertStringIncludes(
      registryContent,
      'import { checkCreditScore as checkCreditScore_v01 } from "./v01/actors/checkCreditScore/v01/checkCreditScore.ts";',
    );
    assertStringIncludes(
      registryContent,
      'import { checkCreditScore as checkCreditScore_v02 } from "./v02/actors/checkCreditScore/v02/checkCreditScore.ts";',
    );
    assertStringIncludes(registryContent, "handler: checkCreditScore_v01,");
    assertStringIncludes(registryContent, "handler: checkCreditScore_v02,");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - does not touch the FSM-scoped aggregate registry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(
      dir,
      "typescript",
      "v01",
      "checkCreditScore",
    );
    const aggregateExists = await Deno.stat(
      `${dir}/async-worker/typescript/typescript-actors-registry.generated.ts`,
    ).then(() => true).catch(() => false);
    assertEquals(aggregateExists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createAsyncOperationLogic - go writes no registry file (Go has no shared-async-op registry)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await createAsyncOperationLogic(dir, "go", "v01", "checkCreditScore");
    const registryExists = await Deno.stat(
      `${dir}/async-worker/go/shared-async-op/generated-registry.go`,
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
      `${absAppRoot}/async-worker/go/shared-async-op/v01/actors/checkCreditScore/v01/go.mod`,
    );
    assertEquals(
      goModContent,
      "module fsm-core-example/shared-async-op/v01/go/actors/checkcreditscore\n\ngo 1.19\n",
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
