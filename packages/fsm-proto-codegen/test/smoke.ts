// Smoke test for gen/typescript: resolves every `exports` entry of
// @pgfsm/proto-codegen (gen/typescript/deno.json) through the Deno workspace,
// round-trips a message through the binary wire format, and reads each service
// descriptor. `deno check` of this file also type-checks the generated .d.ts.
// Run from the repo root (see README's "Verifying a regen"; CI's
// proto-codegen workflow runs it too):
//   deno run --allow-env=BUF_BIGINT_DISABLE packages/fsm-proto-codegen/test/smoke.ts

import { InvokeRequest } from "@pgfsm/proto-codegen/activitygateway/v1/pb";
import { ActivityGatewayService } from "@pgfsm/proto-codegen/activitygateway/v1/connect";
import { Register } from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  CallResult,
  OperationType,
} from "@pgfsm/proto-codegen/syncexecutor/v1/pb";
import { SyncExecutorService } from "@pgfsm/proto-codegen/syncexecutor/v1/connect";

const req = new InvokeRequest({ parentFsmName: "smoke" });
const decoded = InvokeRequest.fromBinary(req.toBinary());
if (decoded.parentFsmName !== "smoke") {
  throw new Error(`InvokeRequest round-trip failed: ${decoded.parentFsmName}`);
}

new Register();

// A oneof round-trip: the sync executor's CallResult carries one outcome.
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

for (
  const [service, typeName] of [
    [ActivityGatewayService, "pgfsm.activitygateway.v1.ActivityGatewayService"],
    [SidecarGatewayService, "pgfsm.sidecargateway.v1.SidecarGatewayService"],
    [SyncExecutorService, "pgfsm.syncexecutor.v1.SyncExecutorService"],
  ] as const
) {
  if (service.typeName !== typeName) {
    throw new Error(`unexpected service typeName: ${service.typeName}`);
  }
}

console.log("typescript stubs OK");
