module pgfsm/async-worker-go

go 1.25.0

require fsm-core-example/go-actors-registry-generated v0.0.0

require fsm-core-example/creditcheck/v01/go/actors/checkreportstable v0.0.0 // indirect

require github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go v0.1.0

require (
	github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go v0.1.1 // indirect
	golang.org/x/net v0.55.0 // indirect
	golang.org/x/sys v0.45.0 // indirect
	golang.org/x/text v0.37.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260526163538-3dc84a4a5aaa // indirect
	google.golang.org/grpc v1.83.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

replace fsm-core-example/go-actors-registry-generated => ./go-actors-registry-generated

replace fsm-core-example/creditcheck/v01/go/actors/checkreportstable => ./creditCheck/v01/actors/CheckReportsTable
