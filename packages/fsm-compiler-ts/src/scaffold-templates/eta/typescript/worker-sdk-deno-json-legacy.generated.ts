// AUTO-GENERATED from worker-sdk-deno-json-legacy.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '{\n  "imports": {\n    "@std/cli": "jsr:@std/cli@1",\n    "@logtape/logtape": "jsr:@logtape/logtape@^2.2"\n  }\n}\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
