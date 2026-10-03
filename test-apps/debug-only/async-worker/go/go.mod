module pgfsm/async-worker-go

go 1.25.0

require debug-only/go-actors-registry-generated v0.0.0

require debug-only/creditcheck/v01/go/actors/checkreportstable v0.0.0 // indirect

require github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go v0.3.0

require (
	github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go v0.2.0 // indirect
	golang.org/x/net v0.58.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.41.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260526163538-3dc84a4a5aaa // indirect
	google.golang.org/grpc v1.83.2 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

replace debug-only/go-actors-registry-generated => ./go-actors-registry-generated

replace debug-only/creditcheck/v01/go/actors/checkreportstable => ./creditCheck/v01/actors/CheckReportsTable
