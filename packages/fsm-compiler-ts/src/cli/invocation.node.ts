// npm/npx build variant of ./invocation.ts (see build-npm.ts's `mappings`
// option and #254). @pgfsm/compiler registers a single bin (`fsm-compiler`),
// so plain `npx @pgfsm/compiler` resolves and runs it directly — no
// `npx -p @pgfsm/compiler -- fsm-compiler` workaround needed.
export const CLI_INVOCATION = "npx @pgfsm/compiler";
