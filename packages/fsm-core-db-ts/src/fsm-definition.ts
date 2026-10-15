// FSM definitions as a deploy-time artifact (SPEC-006): a canonical digest of
// an fsm.json, a read of what fsm_core.fsm_json holds, and a batch loader that
// validates, orders children before parents and loads in one transaction.
import { getLogger } from "@logtape/logtape";
// @ts-types="@types/pg"
import type { PoolClient } from "pg";
import type { Json } from "./database.types.ts";
import type { DBDeps } from "./custom.types.ts";
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";
import { toJsonbParam } from "./pg-utils.ts";

const logger = getLogger(["@pgfsm/db", "fsm-definition"]);

/**
 * One FSM version's compiled-in identity: what the compiler writes into a
 * generated sync-operation registry (`FSM_DEFINITION`) and what the fsmlet
 * compares against the database at startup.
 */
export type FsmDefinitionDigest = {
  fsmName: string;
  fsmVersion: string;
  /** {@linkcode fsmJsonDigest} of that version's fsm.json. */
  fsmJsonSha256: string;
};

/** One parsed fsm.json to load, with its identity. */
export type FsmDefinition = {
  fsmName: string;
  fsmVersion: string;
  fsmJson: Json;
};

/** A child FSM a definition invokes (`asyncOperationType: "fsm"`). */
export type FsmDependentChild = {
  fsm_name: string;
  fsm_version: string;
  fsm_type: string;
  src: string;
};

/** One row of `fsm_core.fsm_json`. */
export type FsmJsonRow = {
  fsm_name: string;
  fsm_version: string;
  fsm_json: Json;
};

export type LoadFsmDefinitionResult = {
  fsmName: string;
  fsmVersion: string;
  /** `unchanged`: already loaded with identical content. */
  status: "loaded" | "unchanged";
};

/**
 * Thrown by {@linkcode loadFsmDefinitions} when the batch is rejected before
 * anything is written (`problems` lists every reason), or when a load fails
 * and the transaction is rolled back (`problems` holds that one failure).
 */
export class FsmDefinitionLoadError extends Error {
  constructor(readonly problems: string[], options?: ErrorOptions) {
    super(
      `FSM definitions not loaded:\n${
        problems.map((p) => `  - ${p}`).join("\n")
      }`,
      options,
    );
    this.name = "FsmDefinitionLoadError";
  }
}

/**
 * RFC 8785 (JCS) serialization: object keys sorted by UTF-16 code unit, no
 * whitespace, strings and numbers exactly as `JSON.stringify` writes them.
 * Makes a digest independent of key order and formatting, which matters
 * because Postgres JSONB reorders keys and drops whitespace.
 */
export function canonicalizeFsmJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number ${value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${
      value.map((v) => canonicalizeFsmJson(v === undefined ? null : v)).join(
        ",",
      )
    }]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${
    entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeFsmJson(v)}`)
      .join(",")
  }}`;
}

/**
 * Lowercase hex SHA-256 of {@linkcode canonicalizeFsmJson}. The compiler
 * hashes the parsed fsm.json file and the fsmlet hashes the parsed JSONB it
 * reads back, so both sides agree whatever the key order or formatting.
 */
export async function fsmJsonDigest(json: Json): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeFsmJson(json));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(hash),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/**
 * Child FSMs a definition invokes: every `invoke` entry, at any state depth,
 * whose `asyncOperationType` is `"fsm"`. Deduplicated by name/version.
 */
export function extractFsmDependentChildren(
  fsmJson: Json,
): FsmDependentChild[] {
  const children = new Map<string, FsmDependentChild>();

  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const state = node as Record<string, unknown>;
    if (Array.isArray(state.invoke)) {
      for (const inv of state.invoke) {
        if (inv === null || typeof inv !== "object") continue;
        const { src, asyncOperationType, asyncOperationVersion } =
          inv as Record<
            string,
            unknown
          >;
        if (
          asyncOperationType === "fsm" && typeof src === "string" &&
          typeof asyncOperationVersion === "string"
        ) {
          children.set(`${src}/${asyncOperationVersion}`, {
            fsm_name: src,
            fsm_version: asyncOperationVersion,
            fsm_type: asyncOperationType,
            src,
          });
        }
      }
    }
    if (state.states !== null && typeof state.states === "object") {
      for (const child of Object.values(state.states)) visit(child);
    }
  };

  visit(fsmJson);
  return [...children.values()];
}

/**
 * Every `fsm_core.fsm_json` row for the given name/version pairs, in one
 * query. A pair with no row is simply absent; a pair can have several rows
 * only on a database loaded before the (fsm_name, fsm_version) unique
 * constraint existed.
 */
export async function getFsmJsonForFsmModules(
  deps: DBDeps,
  modules: { fsm_name: string; fsm_version: string }[],
): Promise<FsmJsonRow[]> {
  if (modules.length === 0) return [];
  const res = await deps.db.query<FsmJsonRow>(
    `SELECT j.fsm_name, j.fsm_version, j.fsm_json
       FROM ${FSM_SCHEMA}.fsm_json j
       JOIN unnest($1::text[], $2::text[]) AS m(fsm_name, fsm_version)
         ON j.fsm_name = m.fsm_name AND j.fsm_version = m.fsm_version`,
    [modules.map((m) => m.fsm_name), modules.map((m) => m.fsm_version)],
  );
  return res.rows;
}

const key = (name: string, version: string) => `${name}/${version}`;

/**
 * Loads a batch of FSM definitions (SPEC-006), or none of them:
 *
 * 1. Validates before writing: conflicting duplicates within the batch,
 *    child FSMs that are neither in the batch nor already loaded, and
 *    dependency cycles within the batch are all reported together.
 * 2. Orders children before the parents that invoke them.
 * 3. Calls `load_fsm_from_json_v2` for each, in one transaction on one
 *    connection; any failure rolls the whole batch back.
 *
 * Re-loading identical content is a no-op reported as `unchanged`.
 */
export async function loadFsmDefinitions(
  deps: DBDeps,
  definitions: FsmDefinition[],
): Promise<LoadFsmDefinitionResult[]> {
  const problems: string[] = [];

  // Duplicates within the batch: identical content collapses, different
  // content is an error (it would fail in the database anyway).
  const byKey = new Map<string, FsmDefinition>();
  for (const def of definitions) {
    const k = key(def.fsmName, def.fsmVersion);
    const seen = byKey.get(k);
    if (!seen) {
      byKey.set(k, def);
    } else if (
      canonicalizeFsmJson(seen.fsmJson) !== canonicalizeFsmJson(def.fsmJson)
    ) {
      problems.push(`${k}: given twice with different content`);
    }
  }

  const childrenOf = new Map<string, FsmDependentChild[]>();
  for (const [k, def] of byKey) {
    childrenOf.set(k, extractFsmDependentChildren(def.fsmJson));
  }

  // Children outside the batch must already be in the database.
  const external = new Map<string, FsmDependentChild>();
  for (const children of childrenOf.values()) {
    for (const c of children) {
      const ck = key(c.fsm_name, c.fsm_version);
      if (!byKey.has(ck)) external.set(ck, c);
    }
  }
  if (external.size > 0) {
    const loaded = new Set(
      (await getFsmJsonForFsmModules(deps, [...external.values()])).map((r) =>
        key(r.fsm_name, r.fsm_version)
      ),
    );
    for (const [k, children] of childrenOf) {
      for (const c of children) {
        const ck = key(c.fsm_name, c.fsm_version);
        if (external.has(ck) && !loaded.has(ck)) {
          problems.push(
            `${k}: invokes child FSM ${ck}, which is neither in this batch nor loaded`,
          );
        }
      }
    }
  }

  // Children first (Kahn's algorithm over in-batch edges); whatever never
  // becomes ready is on or behind a cycle.
  const pending = new Map<string, Set<string>>();
  for (const [k, children] of childrenOf) {
    pending.set(
      k,
      new Set(
        children.map((c) => key(c.fsm_name, c.fsm_version)).filter((ck) =>
          byKey.has(ck)
        ),
      ),
    );
  }
  const order: string[] = [];
  const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([k]) =>
    k
  ).sort();
  while (ready.length > 0) {
    const k = ready.shift()!;
    order.push(k);
    pending.delete(k);
    for (const [other, deps] of pending) {
      if (deps.delete(k) && deps.size === 0) ready.push(other);
    }
    ready.sort();
  }
  if (pending.size > 0) {
    problems.push(
      `dependency cycle among: ${[...pending.keys()].sort().join(", ")}`,
    );
  }

  if (problems.length > 0) throw new FsmDefinitionLoadError(problems);

  const LOAD_FSM_FROM_JSON_FN =
    `${FSM_SCHEMA}.load_fsm_from_json_${FSM_SCHEMA_FN_VERSION}`;
  const client: PoolClient = await deps.db.connect();
  const results: LoadFsmDefinitionResult[] = [];
  let current = "";
  try {
    await client.query("BEGIN");
    for (const k of order) {
      current = k;
      const def = byKey.get(k)!;
      const children = childrenOf.get(k)!;
      const res = await client.query<{ result: { cached?: boolean } }>(
        `SELECT ${LOAD_FSM_FROM_JSON_FN}($1::jsonb, $2::text, $3::text, $4::text, $5::jsonb) AS result`,
        [
          toJsonbParam(def.fsmJson),
          null,
          def.fsmName,
          def.fsmVersion,
          children.length > 0 ? toJsonbParam(children) : null,
        ],
      );
      results.push({
        fsmName: def.fsmName,
        fsmVersion: def.fsmVersion,
        status: res.rows[0]?.result?.cached ? "unchanged" : "loaded",
      });
    }
    await client.query("COMMIT");
    return results;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) =>
      logger.error("ROLLBACK failed: {error}", { error: rollbackErr })
    );
    const reason = err instanceof Error ? err.message : String(err);
    throw new FsmDefinitionLoadError([`${current}: ${reason}`], {
      cause: err,
    });
  } finally {
    client.release();
  }
}
