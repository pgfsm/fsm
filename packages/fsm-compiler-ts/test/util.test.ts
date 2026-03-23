import { assertEquals } from "@std/assert";
import { isTimestampFolderName, isValidDateFolderName, isVersionFolderName } from "../src/util.ts";

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
  assertEquals(isValidDateFolderName("2024-01-15-10"), false);    // missing minute
  assertEquals(isValidDateFolderName(""), false);
});

Deno.test("isTimestampFolderName - valid", () => {
  assertEquals(isTimestampFolderName("20240115103000"), true);
  assertEquals(isTimestampFolderName("99999999999999"), true);
});

Deno.test("isTimestampFolderName - invalid", () => {
  assertEquals(isTimestampFolderName("2024"), false);          // too short
  assertEquals(isTimestampFolderName("202401151030001"), false); // too long
  assertEquals(isTimestampFolderName("2024011510300a"), false);  // non-digit
  assertEquals(isTimestampFolderName(""), false);
});
