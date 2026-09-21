// npm/npx build variant of ./fsmctl-invocation.ts (see
// fsmlet-invocation.node.ts for why plain `npx @pgfsm/sync-worker` isn't
// enough here).
export const CLI_INVOCATION = "npx -p @pgfsm/sync-worker -- fsmctl";
