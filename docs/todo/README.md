# TODO Index

Cross-cutting pending work tracked here. Package-specific TODOs live in each
package's `docs/todo/`.

## Cross-cutting (this folder)

| File                                                   | Summary                                                                                                                   | Status     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [pgmq-queue-name-length.md](pgmq-queue-name-length.md) | Add runtime + compile-time validation for 47-char promise queue name limit — affects `database-src` and `fsm-compiler-ts` | 🔲 Pending |

## Package / app TODOs

| Location                                     | File                                                                                   | Summary                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/fsm-core-worker-ts/docs/todo/`         | [naming-suggestions.md](../../apps/fsm-core-worker-ts/docs/todo/naming-suggestions.md) | `FSMPromiseArchiveData` field rename to camelCase (section 4)                 |
| `packages/database-src-extension/docs/todo/` | [pgxn-publish.md](../../packages/database-src-extension/docs/todo/pgxn-publish.md)     | Verify PGXN upload command and test full build → publish → install round-trip |
| `packages/fsm-compiler-ts/docs/todo/`        | [cli-gaps.md](../../packages/fsm-compiler-ts/docs/todo/cli-gaps.md)                    | Test coverage gaps for CLI commands (section 5)                               |
| `packages/fsm-compiler-ts/`                  | [TODO.md](../../packages/fsm-compiler-ts/TODO.md)                                      | Update `generateFsmJSONFromConfigFile` and its CLI usage                      |
