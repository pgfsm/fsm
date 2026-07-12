import type { z } from "@hono/zod-openapi";

// deno-lint-ignore no-explicit-any
export type ZodSchema =
  | z.ZodUnion<any>
  | z.AnyZodObject
  | z.ZodArray<z.AnyZodObject>;
