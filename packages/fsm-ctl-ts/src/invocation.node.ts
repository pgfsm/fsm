// npm/npx build variant of ./invocation.ts. @pgfsm/ctl ships exactly one
// bin, so plain `npx @pgfsm/ctl` runs it -- no `-p ... --` form needed.
export const CLI_INVOCATION = "npx @pgfsm/ctl";
