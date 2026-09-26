// AUTO-GENERATED from go-mod-aggregate.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  'module <%~ it.moduleName %>\n\ngo <%~ it.goVersion ?? "1.19" %>\n\n<% for (const r of it.requires) { -%>\nrequire <%~ r.modulePath %> <%~ r.version ?? "v0.0.0" %>\n<% } -%>\n\n<% for (const r of it.replaces) { -%>\nreplace <%~ r.modulePath %> => <%~ r.target %>\n<% } -%>\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
