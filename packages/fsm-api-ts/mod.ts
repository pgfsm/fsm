// @pgfsm/api's library export (SPEC-016, #689): the package is mainly the
// `pgfsm-api` bin (src/cli/index.ts). This exports its version only;
// createApp() reads the process environment at import (env.ts), so it isn't
// a library entry point.
export { PACKAGE_VERSION } from "./src/cli/version.ts";
