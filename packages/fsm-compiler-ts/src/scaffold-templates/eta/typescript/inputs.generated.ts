// AUTO-GENERATED from inputs.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  "// <%~ it.label %>: <%~ it.name %>\n// Builds this invoke's input when it starts (SPEC-013): the sync worker calls\n// it with the instance's context and the event that entered the state, and\n// the actor receives what it returns (JSON). For an invoked child FSM, return\n// an object: it's merged over the child's declared context.\n<% if (it.mapperSource) { -%>\n// Copied from machine.ts's input function when this stub was created. It's\n// yours now: edits to machine.ts don't update it.\nexport function <%~ it.fnName %>(context: any, event: any): unknown {\n  const input: (args: { context: any; event: any }) => unknown =\n    <%~ it.mapperSource %>;\n  return input({ context, event });\n}\n<% } else { -%>\nexport function <%~ it.fnName %>(context: any, event: any): unknown {\n  // <%~ it.todo %>\n  return null;\n}\n<% } -%>\n\n",
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
