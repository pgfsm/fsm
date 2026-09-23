import type { Json } from "@pgfsm/db/database.types";
import type {
  ActionObject,
  FsmMachineJson,
  InitialTransitionObject,
  InvokeObject,
  TransitionObject,
} from "../../../database-src/generated/fsm-machine-schema.types.ts";

/**
 * Re-exports only the schema-derived types this package actually imports
 * elsewhere (generated from `packages/database-src/fsm.machine.schema.v3.json`
 * — see `packages/database-src/CLAUDE.md`'s `generate:fsm-types`), so every
 * other file can pull them from `./types/index.ts` alongside this package's
 * own hand-written types, instead of reaching across the package boundary
 * into `../../database-src/generated/` itself. Deliberately not a blanket
 * `export type *` — add a type here only once something in this package
 * actually needs it (`InvokeObject` isn't re-exported for that reason: it's
 * only used internally above, for `FsmDraftInvoke`).
 */
export type {
  ActionObject,
  AtomicStateNode,
  CompoundStateNode,
  FinalStateNode,
  FsmMachineJson,
  HistoryStateNode,
  ParallelStateNode,
} from "../../../database-src/generated/fsm-machine-schema.types.ts";

/**
 * Tied directly to the schema's `invokeObject.asyncOperationType` enum
 * (`InvokeObject["asyncOperationType"]`, imported above) instead of a
 * hand-written literal union, so renaming/adding/removing an
 * `asyncOperationType` value only requires editing `fsm.machine.schema.v3.json`
 * — this type (and every CLI flag/function param typed with it) follows
 * automatically instead of needing a matching hand-edit here.
 */
export type WorkflowType = InvokeObject["asyncOperationType"];

/**
 * `asyncOperationType`/`asyncOperationLanguage` are tied to `InvokeObject`'s
 * own field types (rather than hand-loosened to plain `string`) since every
 * real construction site already populates them from a parsed `InvokeObject`
 * (or a value drawn from its enum, e.g. `OperationLang`), and callers already
 * do literal comparisons like `actor.asyncOperationType === "fsm"` — the
 * tighter type catches typos there instead of just widening past them.
 */
export type ActorReference = {
  src: string;
  asyncOperationType?: InvokeObject["asyncOperationType"];
  asyncOperationVersion?: string;
  asyncOperationLanguage?: InvokeObject["asyncOperationLanguage"];
};

export type FailedMethod = {
  method: string;
  moduleType: string;
  modulePath: string;
};

export type FsmPluginValidationResult = {
  src: string;
  fsmName: string;
  fsmVersion: string;
  fsmAbsFolderPath: string;
  fsmRelativeFolderPath: string;
  fsmParentDirName: string;
  fsmParentAbsFolderPath: string;
  fsmParentRelativeFolderPath: string;
  fsmJsonConfigData: FsmMachineJson | undefined;
  fsmJsonPresent: boolean;
  fsmJsonFollowSchema: boolean;
  isFsmModuleVerified: boolean;
  fsmModuleDefinition: Json;
  failedMethods: FailedMethod[];
  asyncOperationActors: ActorReference[];
  isAsyncOperationActorsVerified?: boolean;
};

export type ActorPluginValidationResult = {
  src: string;
  method: string;
  asyncOperationName: string;
  /**
   * Narrowed to the one value `validateAsyncOperationFromFolders` ever
   * produces, but via `Extract<>` from the schema enum rather than a bare
   * hand-written literal — if `"internalAsyncOperation"` is ever renamed in
   * the schema, this becomes `never` and every assignment site fails to
   * compile instead of silently drifting.
   */
  asyncOperationType: Extract<
    InvokeObject["asyncOperationType"],
    "internalAsyncOperation"
  >;
  asyncOperationVersion: string;
  asyncOperationLanguage: string;
  isVerified: boolean;
  fsmModulePath: string;
  parentFsmName: string;
  parentFsmVersion: string;
  comment: string;
  parentFsmPath: string;
  errorMessage: string | null;
};

/**
 * Languages an operation-logic module can be scaffolded in. Tied to the
 * schema's `InvokeObject["asyncOperationLanguage"]` enum minus `"llm"` —
 * every `switch (lang)` over `OperationLang` in this file relies on
 * exhaustiveness (no `default` case) for its declared return type, so `"llm"`
 * must stay excluded until scaffolding actually supports it; widening to the
 * full schema enum would make those switches fail to compile (a real signal,
 * not a false alarm, for whoever adds `"llm"` support later — they'd need to
 * add a case everywhere this type is switched on). `asyncOperationLanguage`
 * is an optional schema field, so the indexed-access type also carries
 * `undefined` — `NonNullable` strips that before `Exclude` removes `"llm"`.
 * Still schema-derived for the other four: renaming one of
 * `typescript`/`python`/`rust`/`go` in the schema follows automatically here.
 */
export type OperationLang = Exclude<
  NonNullable<InvokeObject["asyncOperationLanguage"]>,
  "llm"
>;

/** The kind of operation logic being scaffolded. */
export type OperationKind = "actions" | "guards" | "delays" | "actors";

/** One actor file written by `writeActorFile` (`operation-logic-scaffold.ts`), recorded for the manifest/barrel. */
export type WrittenActor = {
  /** The actor's original `src` — its identity (invoke id), independent of language. */
  src: string;
  /** Sanitized filename component — the folder/file name on disk. */
  fileBaseName: string;
  asyncOperationLanguage: OperationLang;
  /** Path relative to the version-folder root, e.g. `typescript/actors/checkBureau/checkBureau.ts`. */
  filePath: string;
  /** The callable/importable symbol name in `asyncOperationLanguage` — equals `src` except for Go, which capitalizes it for cross-package export. */
  exportedName: string;
};

/**
 * A {@linkcode WrittenActor} plus the activity-registration identity a
 * worker SDK needs to register with the Activity Gateway (see
 * `actorKey()`/`RegisteredActor` in
 * `packages/fsm-core-async-op-worker/src/sidecar/protocol.ts`) — everything
 * `writeActorsRegistry`/`writeAggregateActorsRegistry`
 * (`operation-logic-scaffold.ts`) need to emit a self-describing
 * registration, not just a name -> callable map. Matches the flattened
 * identity model `fsm-compiler-ts`'s own `validateAsyncOperationFromFolders`
 * already used: `asyncOperationName` is the actor's own `src` (not a
 * separate sub-FSM reference), `asyncOperationVersion` is the parent FSM's
 * version. `asyncOperationType` is `"internalAsyncOperation"` for actors
 * scaffolded from an invoke object (the only kind `toRegisteredActor` builds)
 * or `"sharedAsyncOperation"` for the standalone, non-FSM-scoped pool
 * `create-async-logic.ts` writes into (see that file's
 * `SHARED_ASYNC_OP_FSM_TYPE`) — both are real `InvokeObject`
 * `asyncOperationType` values, tied directly to the schema below rather than
 * hand-written, since neither actually needs a value outside that enum.
 */
export type RegisteredActor = WrittenActor & {
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: InvokeObject["asyncOperationType"];
  asyncOperationName: string;
  asyncOperationVersion: string;
};

/**
 * A registered sync operation's kind — singular, unlike {@linkcode OperationKind}
 * (whose plural values name the on-disk directories: `actions`/`guards`/
 * `delays`/`actors`).
 */
export type SyncOperationType = "action" | "guard" | "delay";

/**
 * One entry {@linkcode writeSyncOperationRegistry} (`operation-logic-scaffold.ts`)
 * emits into a version's `generated-sync-operation-registry.ts` — the
 * sync-logic counterpart of {@linkcode RegisteredActor}, self-describing
 * enough for a worker to register + invoke a stub without a separate
 * name -> callable lookup of its own.
 */
export type SyncOperationRegistration = {
  fsmName: string;
  fsmVersion: string;
  syncOperationType: SyncOperationType;
  syncOperationName: string;
  syncOperationLanguage: OperationLang;
  handler: (...args: unknown[]) => unknown;
};

/**
 * Languages with a natural single-file "re-export everything" idiom directly
 * inside a version folder (`<lang>/actors/<barrel/registry filename>`). Go is
 * deliberately excluded here: each actor already lives in its own
 * subdirectory, which in Go makes it a separate package *and* its own Go
 * module (see `writeGoActorModule`) — there's no re-export syntax across
 * module boundaries, only `require`/`replace`. A per-version Go registry
 * would need its own `go.mod` requiring/replacing every sibling actor module
 * individually; `writeAggregateGoRegistry` already does exactly that, just
 * scoped to the whole app run rather than one version folder at a time — so
 * Go's generated registry lives there instead of here, not because it's
 * missing. (The two blockers an earlier version of this comment cited —
 * unexported Go stub names, and not knowing each actor's own Go module
 * import path — were resolved by #83/#84: see `toGoExportedName` and
 * `goActorModulePath`.)
 */
export type ActorsBarrelLang = "typescript" | "python" | "rust";

/**
 * Which sidecar wire protocol the generated worker SDKs speak. `"grpc"`
 * (default) is the proto-defined `SidecarGatewayService` from #100.
 * `"legacy"` restores the pre-#100 hand-rolled length-prefixed-JSON envelope
 * (`sidecar/protocol.ts`, hand-ported per language via
 * `worker-sdk-protocol.eta`) — kept available behind
 * `--worker-sdk-protocol legacy` for anyone not yet ready to move off it; has
 * no schema-drift protection across languages the way `"grpc"` does, which
 * is the whole reason #100 exists.
 */
export type WorkerSdkProtocol = "grpc" | "legacy";

export interface WriteWorkerSdkOptions {
  protocol?: WorkerSdkProtocol;
}

/**
 * Working shape for the compiler's internal transform pipeline (
 * `generate-fsm-json.ts`) — the space between raw XState `.toJSON()` output
 * and the fully-compiled `FsmMachineJson` (see
 * `../../database-src/generated/fsm-machine-schema.types.ts`, generated from
 * `../../database-src/fsm.machine.schema.v3.json`). Entry/exit items may
 * still be plain strings (XState 5 action shorthand, normalized to
 * actionObjects by `normalizeActionsToObjects`) or `null` placeholders left
 * by conditionally-skipped actions in `machine.ts` (stripped by
 * `removeNullActions`). By the time `generateFsmJSONFromMachineFile`
 * finishes the pipeline, the result should satisfy `FsmMachineJson` —
 * enforced at runtime by the AJV validation in the `showRecommendation` step.
 */
export type FsmDraftAction = string | ActionObject;

/**
 * `Partial<TransitionObject>` minus the legacy `cond` field (dropped — see
 * `TransitionObject`'s own doc comment: not emitted by this compiler) and
 * with `actions` widened to `FsmDraftAction[]` (pre-normalization, may still
 * contain bare action-name strings) instead of strict `ActionObject[]`.
 */
export type FsmDraftTransition =
  & Partial<Omit<TransitionObject, "cond" | "actions">>
  & { actions?: FsmDraftAction[] };

export type FsmDraftInvoke = Partial<InvokeObject> & { src?: string };

/**
 * A flattened, all-optional, recursive merge of `FsmMachineJson` and every
 * state-node variant (`AtomicStateNode`/`CompoundStateNode`/etc.) — the
 * "anything XState's raw `.toJSON()` might contain, before we know which
 * kind of node we're looking at" shape, so it isn't a 1:1 match for any
 * single schema type the way `FsmDraftAction`/`FsmDraftTransition`/
 * `FsmDraftInvoke` are. Those three *are* schema-derived though, and this
 * type is built from them (`entry`/`exit`/`invoke`/`on`/`transitions`), so
 * schema drift there still propagates here. `id`/`key`/`states` stay plain
 * `string`/`Record` — schema-deriving them would gain nothing, since
 * `BaseStateNode.id`/`.key` are themselves just `string`, and `states`
 * recurses into this draft type, not the schema's compiled `StatesObject`.
 * `type` is deliberately loosened past the schema's node-kind literal union
 * (`"atomic" | "compound" | ...`) since a draft node's kind isn't validated
 * yet. `initial` is the one nested shape that does map onto a single schema
 * type, `InitialTransitionObject` — derived the same way as
 * `FsmDraftTransition`.
 */
export type FsmDraftStateNode = {
  id?: string;
  key?: string;
  type?: string;
  entry?: FsmDraftAction[];
  exit?: FsmDraftAction[];
  initial?:
    & Partial<Omit<InitialTransitionObject, "eventType" | "actions" | "target">>
    & { actions?: FsmDraftAction[]; target?: string[] };
  on?: Record<string, FsmDraftTransition[]>;
  transitions?: FsmDraftTransition[];
  invoke?: FsmDraftInvoke[];
  states?: Record<string, FsmDraftStateNode>;
};
