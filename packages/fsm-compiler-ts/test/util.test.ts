import { assertEquals } from "@std/assert";
import {
  extractFsmPluginRefs,
  isNotFoundError,
  isTimestampFolderName,
  isValidDateFolderName,
  isVersionFolderName,
} from "../src/util.ts";
import type { FsmMachineJson } from "../src/types/index.ts";

// Minimal fixtures — only `states` matters for extractFsmPluginRefs, but the
// full FsmMachineJson contract (matching what real callers always have) is
// enforced at the type level, so the required id/key/type fields are filled
// in with placeholders here.
const baseFsm = { id: "root", key: "root", type: "compound" as const };

const baseInvoke = {
  type: "xstate.invoke",
  id: "0.idle",
  asyncOperationType: "internalAsyncOperation" as const,
  asyncOperationVersion: "v01",
};
const baseState = { id: "root.idle", key: "idle", type: "atomic" as const };

Deno.test("extractFsmPluginRefs - defaults actor asyncOperationLanguage to typescript", () => {
  const fsmData: FsmMachineJson = {
    ...baseFsm,
    states: {
      idle: {
        ...baseState,
        invoke: [{ ...baseInvoke, src: "someActor" }],
        on: {},
      },
    },
  };
  const { actors } = extractFsmPluginRefs(fsmData);
  assertEquals(actors.length, 1);
  assertEquals(actors[0].src, "someActor");
  assertEquals(actors[0].asyncOperationLanguage, "typescript");
});

Deno.test("extractFsmPluginRefs - preserves explicit actor asyncOperationLanguage", () => {
  const fsmData: FsmMachineJson = {
    ...baseFsm,
    states: {
      idle: {
        ...baseState,
        invoke: [{
          ...baseInvoke,
          src: "pyActor",
          asyncOperationLanguage: "python",
        }],
        on: {},
      },
    },
  };
  const { actors } = extractFsmPluginRefs(fsmData);
  assertEquals(actors[0].asyncOperationLanguage, "python");
});

Deno.test("isVersionFolderName - valid", () => {
  assertEquals(isVersionFolderName("v01"), true);
  assertEquals(isVersionFolderName("v02"), true);
  assertEquals(isVersionFolderName("v99"), true);
});

Deno.test("isVersionFolderName - invalid", () => {
  assertEquals(isVersionFolderName("v1"), false);
  assertEquals(isVersionFolderName("v001"), false);
  assertEquals(isVersionFolderName("abc"), false);
  assertEquals(isVersionFolderName("01"), false);
  assertEquals(isVersionFolderName(""), false);
});

Deno.test("isValidDateFolderName - valid", () => {
  assertEquals(isValidDateFolderName("2024-01-15-10-30"), true);
  assertEquals(isValidDateFolderName("2024-12-31-23-59"), true);
  assertEquals(isValidDateFolderName("2000-06-01-00-00"), true);
});

Deno.test("isValidDateFolderName - invalid", () => {
  assertEquals(isValidDateFolderName("not-a-date"), false);
  assertEquals(isValidDateFolderName("2024-13-01-10-30"), false); // month 13
  assertEquals(isValidDateFolderName("2024-01-32-10-30"), false); // day 32
  assertEquals(isValidDateFolderName("2024-01-15-25-00"), false); // hour 25
  assertEquals(isValidDateFolderName("2024-01-15-10"), false); // missing minute
  assertEquals(isValidDateFolderName(""), false);
});

Deno.test("isTimestampFolderName - valid", () => {
  assertEquals(isTimestampFolderName("20240115103000"), true);
  assertEquals(isTimestampFolderName("99999999999999"), true);
});

Deno.test("isTimestampFolderName - invalid", () => {
  assertEquals(isTimestampFolderName("2024"), false); // too short
  assertEquals(isTimestampFolderName("202401151030001"), false); // too long
  assertEquals(isTimestampFolderName("2024011510300a"), false); // non-digit
  assertEquals(isTimestampFolderName(""), false);
});

Deno.test("isNotFoundError - matches a real Deno.errors.NotFound instance", () => {
  assertEquals(isNotFoundError(new Deno.errors.NotFound("nope")), true);
});

Deno.test("isNotFoundError - matches a raw Node ENOENT-shaped error (the unwrapped @deno/shim-deno remove()/removeSync() shape under the npm/npx build — see #278)", () => {
  const rawNodeEnoent = Object.assign(new Error("ENOENT: no such file"), {
    code: "ENOENT",
  });
  assertEquals(isNotFoundError(rawNodeEnoent), true);
});

Deno.test("isNotFoundError - rejects other errors and non-error values", () => {
  assertEquals(
    isNotFoundError(new Deno.errors.PermissionDenied("nope")),
    false,
  );
  assertEquals(
    isNotFoundError(Object.assign(new Error("busy"), { code: "EBUSY" })),
    false,
  );
  assertEquals(isNotFoundError(new Error("plain error, no code")), false);
  assertEquals(isNotFoundError("not an error"), false);
  assertEquals(isNotFoundError(null), false);
  assertEquals(isNotFoundError(undefined), false);
});
