// npm/npx build variant of ./gateway-invocation.ts (see build-npm.ts's
// `mappings` option and #262). Unlike @pgfsm/compiler (single bin, plain
// `npx @pgfsm/compiler` works), this package registers two bins neither
// matching the derived package name — `npx @pgfsm/async-worker` alone
// can't determine which to run. See this package's CLAUDE.md's "Multi-bin
// npx gotcha".
export const CLI_INVOCATION =
  "npx -p @pgfsm/async-worker -- async-operation-worker-gateway";
