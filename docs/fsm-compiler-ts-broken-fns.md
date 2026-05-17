# fsm-compiler-ts — Broken Functions After fsm-core-db-ts Rename

Functions broken in `packages/fsm-compiler-ts/src/` due to renames applied in `apps/fsm-core-db-ts/src/`.

| Old Name | New Name | File | Import Line | Call Line(s) |
|---|---|---|---|---|
| `loadFsmFromJsonV2` | `loadFsmFromJson` | `loadFsmJSON.ts` | L4 | L27 |
| `loadFsmFromJsonV2` | `loadFsmFromJson` | `loadAndVerifyFsm.ts` | L11 | L150 |
