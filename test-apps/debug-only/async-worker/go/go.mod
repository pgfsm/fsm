module pgfsm/async-worker-go

go 1.26.0

require debug-only/actor-registry-aggregate-generated v0.0.0

require debug-only/creditcheck/v01/go/actors/checkreportstable v0.0.0 // indirect

require debug-only/creditcheck/v03/go/actors/checkreportstable v0.0.0 // indirect

require debug-only/spec012cancel/v01/go/actors/spec012workgo v0.0.0 // indirect

require github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go v0.4.0

require (
	github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go v0.3.0 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260526163538-3dc84a4a5aaa // indirect
	google.golang.org/grpc v1.83.2 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

replace debug-only/actor-registry-aggregate-generated => ./actor-registry-aggregate-generated

replace debug-only/creditcheck/v01/go/actors/checkreportstable => ./creditCheck/v01/actors/CheckReportsTable

replace debug-only/creditcheck/v03/go/actors/checkreportstable => ./creditCheck/v03/actors/CheckReportsTable

replace debug-only/spec012cancel/v01/go/actors/spec012workgo => ./spec012Cancel/v01/actors/spec012WorkGo
