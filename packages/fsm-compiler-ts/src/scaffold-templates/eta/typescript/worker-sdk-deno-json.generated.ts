// AUTO-GENERATED from worker-sdk-deno-json.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '{\n  "imports": {\n    "@std/cli": "jsr:@std/cli@1",\n    "@logtape/logtape": "jsr:@logtape/logtape@^2.2",\n    "@connectrpc/connect": "npm:@connectrpc/connect@^1.7.0",\n    "@connectrpc/connect-node": "npm:@connectrpc/connect-node@^1.7.0"\n  }\n}\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
