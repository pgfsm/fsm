// AUTO-GENERATED from sync-worker-deno-json.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '{\n  "imports": {\n    "@pgfsm/sync-worker": "npm:@pgfsm/sync-worker@^0.2.0"\n  }\n}\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
