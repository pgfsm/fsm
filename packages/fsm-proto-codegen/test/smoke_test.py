# Smoke test for gen/python: run after `pip install packages/fsm-proto-codegen/gen/python`.
# Only this script's own directory (test/) lands on sys.path, so the installed
# package is what gets imported, not the checkout's gen/python. Imports every generated module, round-trips a message through the wire
# format, and subclasses each servicer. See README's "Verifying a regen"; CI's
# proto-codegen workflow runs it too.

from pgfsm.activitygateway.v1 import activity_gateway_pb2 as ag
from pgfsm.activitygateway.v1 import activity_gateway_pb2_grpc as ag_grpc
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2 as sc
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2_grpc as sc_grpc

req = ag.InvokeRequest(parent_fsm_name="smoke")
decoded = ag.InvokeRequest.FromString(req.SerializeToString())
assert decoded.parent_fsm_name == "smoke", decoded

sc.Register()


class ActivityGateway(ag_grpc.ActivityGatewayServiceServicer):
    pass


class SidecarGateway(sc_grpc.SidecarGatewayServiceServicer):
    pass


ActivityGateway()
SidecarGateway()
ag_grpc.ActivityGatewayServiceStub
sc_grpc.SidecarGatewayServiceStub

print("python stubs OK")
