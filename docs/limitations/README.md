# Limitations Index

Cross-cutting known constraints tracked here. Package-specific limitations live
in each package's `docs/limitations/`.

## Cross-cutting (this folder)

| File                                                   | Summary                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [pgmq-queue-name-length.md](pgmq-queue-name-length.md) | pgmq enforces a 47-char queue name limit — constrains FSM and promise actor naming conventions |

## Package limitations

| Location                                     | File                                                               | Summary                        |
| -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| `packages/fsm-compiler-ts/docs/limitations/` | [bugs.md](../../packages/fsm-compiler-ts/docs/limitations/bugs.md) | Known bugs in the FSM compiler |
