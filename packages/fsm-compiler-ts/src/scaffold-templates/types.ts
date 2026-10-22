import type { OperationKind, OperationLang } from "../types/index.ts";

/** Values derived from a `(kind, name, lang)` triple, passed to every template function. */
export type TemplateInput = {
  name: string;
  fnName: string;
  label: string;
  todo: string;
  lang: OperationLang;
  /**
   * An input stub's pre-fill (SPEC-013, option A′): the source of the
   * machine.ts input function it was compiled from, when known.
   */
  mapperSource?: string;
};

/** Renders one operation-logic stub for a given kind. */
export type TemplateFn = (input: TemplateInput) => string;

/** Renders a file-level header (e.g. a package declaration) for a given kind. */
export type PreambleFn = (kind: OperationKind) => string;

/** All templates for a single language. `preamble` defaults to `""` when absent. */
export type LanguageTemplateSet = {
  /** Input stubs (SPEC-013) are TypeScript only: the sync worker runs them. */
  stubs: Record<Exclude<OperationKind, "inputs">, TemplateFn> & {
    inputs?: TemplateFn;
  };
  preamble?: PreambleFn;
};
