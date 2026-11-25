// Smoke test for gen-sync/typescript: resolves every `exports` entry of
// @pgfsm/proto-codegen-sync (gen-sync/typescript/deno.json) through the Deno
// workspace, round-trips a message (a oneof) through the binary wire format,
// and reads the service descriptor. `deno check` of this file also
// type-checks the generated .d.ts. Run from the repo root (see README's
// "Verifying a regen"; CI's proto-codegen workflow runs it too):
//   deno run --allow-env=BUF_BIGINT_DISABLE packages/fsm-proto-codegen/test/smoke-sync.ts

import {
  CallResult,
  OperationType,
} from "@pgfsm/proto-codegen-sync/syncexecutor/v1/pb";
import { SyncExecutorService } from "@pgfsm/proto-codegen-sync/syncexecutor/v1/connect";

const result = CallResult.fromBinary(
  new CallResult({
    callId: "c1",
    outcome: { case: "valueJson", value: '{"n":1}' },
  }).toBinary(),
);
if (result.outcome.case !== "valueJson" || result.outcome.value !== '{"n":1}') {
  throw new Error(
    `CallResult round-trip failed: ${JSON.stringify(result.outcome)}`,
  );
}
if (OperationType.GUARD !== 2) {
  throw new Error(`unexpected OperationType.GUARD: ${OperationType.GUARD}`);
}
if (
  SyncExecutorService.typeName !== "pgfsm.syncexecutor.v1.SyncExecutorService"
) {
  throw new Error(
    `unexpected service typeName: ${SyncExecutorService.typeName}`,
  );
}

console.log("typescript sync stubs OK");
