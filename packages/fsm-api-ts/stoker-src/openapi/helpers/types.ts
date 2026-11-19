import type { z } from "@hono/zod-openapi";

export type ZodSchema =
  // deno-lint-ignore no-explicit-any -- ZodUnion is generic over its member tuple, which varies per schema
  | z.ZodUnion<any>
  | z.AnyZodObject
  | z.ZodArray<z.AnyZodObject>;
