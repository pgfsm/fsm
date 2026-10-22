module debug-only/actor-registry-aggregate-generated

go 1.19

require debug-only/creditcheck/v01/go/actors/checkreportstable v0.0.0

require debug-only/creditcheck/v03/go/actors/checkreportstable v0.0.0

require debug-only/spec012cancel/v01/go/actors/spec012workgo v0.0.0

replace debug-only/creditcheck/v01/go/actors/checkreportstable => ../creditCheck/v01/actors/CheckReportsTable

replace debug-only/creditcheck/v03/go/actors/checkreportstable => ../creditCheck/v03/actors/CheckReportsTable

replace debug-only/spec012cancel/v01/go/actors/spec012workgo => ../spec012Cancel/v01/actors/spec012WorkGo
