// AUTO-GENERATED from actors.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '// <%~ it.label %>: <%~ it.name %>\n\n// How many invokes of this actor one worker runs at once. Above 1, the\n// handler must be safe to run concurrently (no unguarded shared state, only\n// concurrency-safe clients). Delivery is at-least-once, so the handler must\n// also be idempotent: the same invoke can arrive more than once.\nexport const maxConcurrency = 1;\n\nexport function <%~ it.fnName %>(input: unknown): unknown {\n  // <%~ it.todo %>\n  return { input, msg: "<%~ it.name %> actor invoked by <%~ it.lang %>" };\n}\n\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
