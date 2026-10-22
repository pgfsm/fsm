import type { OperationKind, OperationLang } from "../types/index.ts";
import type { LanguageTemplateSet, TemplateFn } from "./types.ts";
import { typescriptTemplates } from "./typescript.ts";
import { pythonTemplates } from "./python.ts";
import { rustTemplates } from "./rust.ts";
import { goTemplates } from "./go.ts";

const TEMPLATE_REGISTRY: Record<OperationLang, LanguageTemplateSet> = {
  typescript: typescriptTemplates,
  python: pythonTemplates,
  rust: rustTemplates,
  go: goTemplates,
};

/** Looks up the stub template for a given language and kind. */
export function getTemplate(
  lang: OperationLang,
  kind: OperationKind,
): TemplateFn {
  const template = TEMPLATE_REGISTRY[lang].stubs[kind];
  if (!template) {
    throw new Error(`No ${lang} template for ${kind} stubs`);
  }
  return template;
}

/** Looks up the file-level preamble for a given language and kind (`""` if none). */
export function getPreamble(
  lang: OperationLang,
  kind: OperationKind,
): string {
  return TEMPLATE_REGISTRY[lang].preamble?.(kind) ?? "";
}
