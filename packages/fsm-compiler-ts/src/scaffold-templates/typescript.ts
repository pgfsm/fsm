import type { LanguageTemplateSet } from "./types.ts";
import { render as actions } from "./eta/typescript/actions.generated.ts";
import { render as guards } from "./eta/typescript/guards.generated.ts";
import { render as delays } from "./eta/typescript/delays.generated.ts";
import { render as actors } from "./eta/typescript/actors.generated.ts";
import { render as inputs } from "./eta/typescript/inputs.generated.ts";

/** TypeScript operation-logic stub templates. Sourced from eta/typescript/*.eta. */
export const typescriptTemplates: LanguageTemplateSet = {
  stubs: { actions, guards, delays, actors, inputs },
};
