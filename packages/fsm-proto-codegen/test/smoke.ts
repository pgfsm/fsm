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

const req = new InvokeRequest({ parentFsmName: "smoke" });
const decoded = InvokeRequest.fromBinary(req.toBinary());
if (decoded.parentFsmName !== "smoke") {
  throw new Error(`InvokeRequest round-trip failed: ${decoded.parentFsmName}`);
}

new Register();

for (
  const [service, typeName] of [
    [ActivityGatewayService, "pgfsm.activitygateway.v1.ActivityGatewayService"],
    [SidecarGatewayService, "pgfsm.sidecargateway.v1.SidecarGatewayService"],
  ] as const
) {
  if (service.typeName !== typeName) {
    throw new Error(`unexpected service typeName: ${service.typeName}`);
  }
}

console.log("typescript stubs OK");
