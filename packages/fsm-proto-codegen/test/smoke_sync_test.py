# Smoke test for gen-sync/python: run after `pip install packages/fsm-proto-codegen/gen-sync/python`.
# Only this script's own directory (test/) lands on sys.path, so the installed
# package is what gets imported, not the checkout's gen-sync/python. Imports
# every generated module, round-trips a message (a oneof) through the wire
# format, and subclasses the servicer. See README's "Verifying a regen"; CI's
# proto-codegen workflow runs it too.

from pgfsm.syncexecutor.v1 import sync_executor_pb2 as se
from pgfsm.syncexecutor.v1 import sync_executor_pb2_grpc as se_grpc

result = se.CallResult.FromString(
    se.CallResult(call_id="c1", no_value=se.NoValue()).SerializeToString()
)
assert result.WhichOneof("outcome") == "no_value", result
assert se.OPERATION_TYPE_GUARD == 2


class SyncExecutor(se_grpc.SyncExecutorServiceServicer):
    pass


SyncExecutor()
se_grpc.SyncExecutorServiceStub

print("python sync stubs OK")
