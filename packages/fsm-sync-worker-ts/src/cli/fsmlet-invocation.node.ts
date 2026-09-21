// npm/npx build variant of ./fsmlet-invocation.ts (see build-npm.ts's
// `mappings` option and #266). This package registers four bins, none
// matching the derived package name — plain `npx @pgfsm/sync-worker`
// alone can't determine which to run. See this package's CLAUDE.md's
// "Multi-bin npx gotcha".
export const CLI_INVOCATION = "npx -p @pgfsm/sync-worker -- fsmlet";
