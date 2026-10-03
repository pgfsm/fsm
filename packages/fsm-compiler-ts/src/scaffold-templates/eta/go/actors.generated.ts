// AUTO-GENERATED from actors.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '// <%~ it.label %>: <%~ it.name %>\n\n// MaxConcurrency is how many invokes of this actor one worker runs at once.\n// Above 1, the handler runs on several goroutines at once: guard shared state\n// with a sync.Mutex, atomics or channels. Delivery is at-least-once, so the\n// handler must also be idempotent: the same invoke can arrive more than once.\nconst MaxConcurrency = 1\n\nfunc <%~ it.fnName %>(input any) (any, error) {\n\t// <%~ it.todo %>\n\treturn map[string]any{"input": input, "msg": "<%~ it.name %> actor invoked by <%~ it.lang %>"}, nil\n}\n\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
