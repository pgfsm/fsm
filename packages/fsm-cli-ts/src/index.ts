// Library API behind the `pgfsm` CLI (SPEC-004). The CLI in src/cli/pgfsm.ts
// is the supported entry point; these are exported for scripting and tests.
export { addFsm, FsmExistsError, MachineImportError } from "./commands/add.ts";
export {
  checkCreateTarget,
  checkProjectName,
  CreateError,
  createProject,
} from "./commands/create.ts";
export type { CreateOptions } from "./commands/create.ts";
export { syncProject } from "./commands/sync.ts";
export type { SyncResult } from "./commands/sync.ts";
export {
  CONFIG_FILE_NAME,
  defaultConfig,
  findProjectRoot,
  loadProject,
  NoProjectError,
  readConfig,
  upsertFsm,
  writeConfig,
} from "./project.ts";
export type { FsmEntry, Project, ProjectConfig } from "./project.ts";
export { formatReport, WriteReport } from "./report.ts";
export { resolveSources, SourceError } from "./source.ts";
export type {
  Ask,
  IdentityFlags,
  ResolvedSource,
  SourceKind,
} from "./source.ts";
export { PACKAGE_VERSION } from "./version.ts";
