import { DELAY_ACTION_NAME_PREFIX, toGoExportedName } from "../util.ts";
import type { OperationKind, OperationLang } from "../types/index.ts";
import type { TemplateInput } from "./types.ts";

/**
 * Derives the values every template needs from a `(kind, name, lang)` triple.
 * `lang` renames the exported symbol for Go actors (see
 * {@linkcode toGoExportedName}) and is passed through as-is for every actor
 * template's invoked-by message; every other kind ignores it.
 */
export function deriveTemplateInput(
  kind: OperationKind,
  name: string,
  lang: OperationLang,
): TemplateInput {
  // Delays are exposed under a prefixed function name; the comment keeps the
  // original name for readability.
  const rawFnName = kind === "delays"
    ? `${DELAY_ACTION_NAME_PREFIX}${name}`
    : name;
  const fnName = (lang === "go" && kind === "actors")
    ? toGoExportedName(rawFnName)
    : rawFnName;
  const label = kind.slice(0, 1).toUpperCase() + kind.slice(1, -1); // Action/Guard/Delay/Actor/Input
  const todo = kind === "actors"
    ? "TODO: implement actor logic"
    : kind === "delays"
    ? "TODO: implement delay logic (return ms)"
    : kind === "inputs"
    ? "TODO: return this invoke's input, built from context and event"
    : "TODO: implement";

  return { name, fnName, label, todo, lang };
}
