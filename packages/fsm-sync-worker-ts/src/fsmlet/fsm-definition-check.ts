import {
  canonicalizeFsmJson,
  type DBDeps,
  type FsmDefinitionDigest,
  fsmJsonDigest,
  type FsmJsonRow,
  type FsmModule,
  getFsmJsonForFsmModules,
} from "@pgfsm/db";

/**
 * Why an FSM version this fsmlet serves can't run against the database
 * (SPEC-006): no definition loaded, several different ones loaded (left over
 * from concurrent loads before the unique constraint), or one whose content
 * differs from the fsm.json this worker was compiled from.
 */
export type FsmDefinitionProblem = {
  fsm_name: string;
  fsm_version: string;
  reason: "missing" | "ambiguous" | "drifted" | "undigested";
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
      ].join("\n"),
    );
    this.name = "FsmDefinitionCheckError";
  }
}

/**
 * Classifies each served module against the `fsm_core.fsm_json` rows read
 * for it and its compiled digest. A served module with no digest is itself a
 * problem (`undigested`): drift can't be ruled out for it.
 */
export async function classifyFsmDefinitions(
  modules: FsmModule[],
  rows: FsmJsonRow[],
  digests: FsmDefinitionDigest[],
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
    }
  }
  return problems;
}

/**
 * One read of `fsm_core.fsm_json` for every served module; throws
 * {@linkcode FsmDefinitionCheckError} listing every missing, ambiguous or
 * drifted definition.
 */
export async function checkFsmDefinitions(
  deps: DBDeps,
  modules: FsmModule[],
  digests: FsmDefinitionDigest[],
): Promise<void> {
  const rows = await getFsmJsonForFsmModules(deps, modules);
  const problems = await classifyFsmDefinitions(modules, rows, digests);
  if (problems.length > 0) throw new FsmDefinitionCheckError(problems);
}
