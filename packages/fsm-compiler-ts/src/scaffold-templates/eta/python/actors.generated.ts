// AUTO-GENERATED from actors.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '# <%~ it.label %>: <%~ it.name %>\n\n# How many invokes of this actor one worker runs at once. Above 1, the\n# handler runs on several threads at once and must be thread-safe (no\n# unguarded shared state, only thread-safe clients). Delivery is\n# at-least-once, so the handler must also be idempotent: the same invoke can\n# arrive more than once.\nMAX_CONCURRENCY = 1\n\n\ndef <%~ it.fnName %>(input):\n    # <%~ it.todo %>\n    return {"input": input, "msg": "<%~ it.name %> actor invoked by <%~ it.lang %>"}\n\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
