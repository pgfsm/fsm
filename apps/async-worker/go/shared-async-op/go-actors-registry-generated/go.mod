module apps/shared-async-op/go-actors-registry-generated

go 1.19

require apps/shared-async-op/v01/go/actors/byefrompgfsm v0.0.0

require apps/shared-async-op/v01/go/actors/hellofrompgfsm v0.0.0

replace apps/shared-async-op/v01/go/actors/byefrompgfsm => ../v01/actors/byeFromPgfsm

replace apps/shared-async-op/v01/go/actors/hellofrompgfsm => ../v01/actors/helloFromPgfsm
