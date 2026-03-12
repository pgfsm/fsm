import type { ZodSchema } from "./types.ts";

import oneOf from "./one-of.ts";

const jsonContentOneOf = <
  T extends ZodSchema,
>(schemas: T[], description: string) => {
  return {
    content: {
      "application/json": {
        schema: {
          oneOf: oneOf(schemas),
        },
      },
    },
    description,
  };
};

export default jsonContentOneOf;
