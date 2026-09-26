// npm/npx build variant of ./gateway-ctl-invocation.ts (see
// gateway-invocation.node.ts for why plain `npx @pgfsm/async-worker-gateway` isn't
// enough here).
export const CLI_INVOCATION =
  "npx -p @pgfsm/async-worker-gateway -- async-operation-worker-gateway-ctl";
