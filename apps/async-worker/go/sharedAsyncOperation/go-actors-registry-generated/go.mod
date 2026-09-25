module apps/sharedasyncoperation/go-actors-registry-generated

go 1.19

require apps/sharedasyncoperation/v01/go/actors/byefrompgfsm v0.0.0

require apps/sharedasyncoperation/v01/go/actors/hellofrompgfsm v0.0.0

replace apps/sharedasyncoperation/v01/go/actors/byefrompgfsm => ../v01/actors/byeFromPgfsm

replace apps/sharedasyncoperation/v01/go/actors/hellofrompgfsm => ../v01/actors/helloFromPgfsm
