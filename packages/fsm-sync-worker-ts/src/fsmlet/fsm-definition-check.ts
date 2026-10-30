import {
  canonicalizeFsmJson,
  type DBDeps,
  type FsmDefinitionDigest,
  fsmJsonDigest,
  type FsmJsonRow,
  type FsmModule,
  getFsmJsonForFsmModules,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";
import { delayKey } from "./delays.ts";
import type { SyncOperationRegistration } from "./type.ts";

/**
 * Why an FSM version this fsmlet serves can't run against the database
 * (SPEC-006): no definition loaded, several different ones loaded (left over
 * from concurrent loads before the unique constraint), one whose content
 * differs from the fsm.json this worker was compiled from, or one naming a
 * guard, delay or input mapper this worker has no implementation for (#621).
 */
export type FsmDefinitionProblem = {
  fsm_name: string;
  fsm_version: string;
  reason: "missing" | "ambiguous" | "drifted" | "undigested" | "unimplemented";
  detail: string;
};

/** Thrown by {@linkcode checkFsmDefinitions}; lists every failing module. */
export class FsmDefinitionCheckError extends Error {
  constructor(readonly problems: FsmDefinitionProblem[]) {
    super(
      [
        "FSM definitions in the database don't match this worker:",
        ...problems.map((p) =>
          `  - ${p.fsm_name}/${p.fsm_version}: ${p.reason} (${p.detail})`
        ),
        "Load missing definitions with `pgfsmctl fsm load <fsm-folder>` against this database.",
        "A drifted definition can't be reloaded under the same version: rebuild the worker from the loaded fsm.json, or give the changed fsm.json a new version and load that.",
        ...(problems.some((p) => p.reason === "unimplemented")
          ? [
            "An unimplemented guard, delay or input mapper has no entry in SYNC_OPERATION_REGISTRATIONS: regenerate the sync worker (its stubs are kept) so the generated registry includes it.",
          ]
          : []),
      ].join("\n"),
    );
    this.name = "FsmDefinitionCheckError";
  }
}

type SyncOperationRef = {
  type: "guard" | "delay" | "input";
  name: string;
};

/**
 * The guards, named delays and input mappers an fsm.json calls (#621): a
 * transition's `guard`; an `after` raise's delay key when it isn't a number
 * of milliseconds (what the worker passes to the delay function); an
 * invoke's `inputName`. Actions aren't listed: a missing action is skipped,
 * as in XState.
 */
export function syncOperationsNamedIn(fsmJson: Json): SyncOperationRef[] {
  const found = new Map<string, SyncOperationRef>();
  const add = (type: SyncOperationRef["type"], name: string) =>
    found.set(`${type}:${name}`, { type, name });
  const walk = (node: Json | undefined): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (typeof node.guard === "string") add("guard", node.guard);
    if (typeof node.inputName === "string") add("input", node.inputName);
    if (node.type === "xstate.raise") {
      const key = delayKey(node);
      if (key !== undefined && key !== "" && !/^\d+(\.\d+)?$/.test(key)) {
        add("delay", key);
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(fsmJson);
  return [...found.values()].sort((a, b) =>
    a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
  );
}

/**
 * Classifies each served module against the `fsm_core.fsm_json` rows read
 * for it and its compiled digest. A served module with no digest is itself a
 * problem (`undigested`): drift can't be ruled out for it. Given the
 * registrations, a definition that matches but names a guard, delay or input
 * mapper with no registration for that FSM version is `unimplemented` (#621).
 */
export async function classifyFsmDefinitions(
  modules: FsmModule[],
  rows: FsmJsonRow[],
  digests: FsmDefinitionDigest[],
  registrations?: SyncOperationRegistration[],
): Promise<FsmDefinitionProblem[]> {
  const problems: FsmDefinitionProblem[] = [];
  for (const m of modules) {
    const matching = rows.filter((r) =>
      r.fsm_name === m.fsm_name && r.fsm_version === m.fsm_version
    );
    if (matching.length === 0) {
      problems.push({
        ...m,
        reason: "missing",
        detail: "not in fsm_core.fsm_json",
      });
      continue;
    }
    const distinct = new Set(
      matching.map((r) => canonicalizeFsmJson(r.fsm_json)),
    );
    if (distinct.size > 1) {
      problems.push({
        ...m,
        reason: "ambiguous",
        detail: `${distinct.size} different definitions loaded`,
      });
      continue;
    }
    const compiled = digests.find((d) =>
      d.fsmName === m.fsm_name && d.fsmVersion === m.fsm_version
    );
    if (!compiled) {
      problems.push({
        ...m,
        reason: "undigested",
        detail: "no entry in fsmDefinitions; regenerate the sync worker",
      });
      continue;
    }
    const loaded = await fsmJsonDigest(matching[0].fsm_json);
    if (loaded !== compiled.fsmJsonSha256) {
      problems.push({
        ...m,
        reason: "drifted",
        detail: `database sha256 ${loaded.slice(0, 12)}…, compiled ${
          compiled.fsmJsonSha256.slice(0, 12)
        }…`,
      });
      continue;
    }
    if (!registrations) continue;
    const unimplemented = syncOperationsNamedIn(matching[0].fsm_json).filter(
      (op) =>
        !registrations.some((r) =>
          r.fsmName === m.fsm_name && r.fsmVersion === m.fsm_version &&
          r.syncOperationType === op.type && r.syncOperationName === op.name
        ),
    );
    if (unimplemented.length > 0) {
      problems.push({
        ...m,
        reason: "unimplemented",
        detail: `no implementation for ${
          unimplemented.map((op) => `${op.type} ${op.name}`).join(", ")
        }`,
      });
    }
  }
  return problems;
}

/**
 * One read of `fsm_core.fsm_json` for every served module; throws
 * {@linkcode FsmDefinitionCheckError} listing every missing, ambiguous,
 * drifted, undigested or (given the registrations) unimplemented definition.
 */
export async function checkFsmDefinitions(
  deps: DBDeps,
  modules: FsmModule[],
  digests: FsmDefinitionDigest[],
  registrations?: SyncOperationRegistration[],
): Promise<void> {
  const rows = await getFsmJsonForFsmModules(deps, modules);
  const problems = await classifyFsmDefinitions(
    modules,
    rows,
    digests,
    registrations,
  );
  if (problems.length > 0) throw new FsmDefinitionCheckError(problems);
}
