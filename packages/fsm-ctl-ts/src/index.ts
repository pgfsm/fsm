// Library surface of @pgfsm/ctl. The package is the `pgfsmctl` bin
// (src/cli/pgfsmctl.ts), which talks only to the pgfsm API (SPEC-016, #690);
// this exports its version. The fsmscheduler loop it used to export lives
// with the journey tests that use it (apps/fsm-core-example/test-support).
export { PACKAGE_VERSION } from "./version.ts";
