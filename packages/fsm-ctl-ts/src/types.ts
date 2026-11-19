// The shapes pgfsmctl sends to and reads from the API. Declared here rather
// than imported from @pgfsm/db: pgfsmctl talks only to the API and depends on
// neither pg nor @pgfsm/db (SPEC-016, #690).

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/** One `<folder>/<fsmName>/<version>/fsm.json`, as POST /admin/definitions takes it. */
export type FsmDefinition = {
  fsmName: string;
  fsmVersion: string;
  fsmJson: Json;
};

/** One entry of POST /admin/definitions' response. */
export type LoadFsmDefinitionResult = {
  fsmName: string;
  fsmVersion: string;
  status: "loaded" | "unchanged";
};

/** One row of GET /definitions. */
export type FsmDefinitionSummary = {
  fsm_name: string;
  fsm_version: string;
  fsm_type: string | null;
  fsm_json_sha256: string;
};

/** GET /definitions/<name>/versions/<version>. */
export type FsmJsonRow = {
  fsm_name: string;
  fsm_version: string;
  fsm_json: Json;
};
