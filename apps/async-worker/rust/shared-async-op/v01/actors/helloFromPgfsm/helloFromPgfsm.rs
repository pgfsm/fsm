// Actor: helloFromPgfsm
#[allow(non_snake_case)]
pub fn helloFromPgfsm(input: serde_json::Value) -> serde_json::Value {
    // TODO: implement actor logic
    serde_json::json!({ "input": input, "msg": "helloFromPgfsm actor invoked by rust" })
}
