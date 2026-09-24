// Actor: byeFromPgfsm
#[allow(non_snake_case)]
pub fn byeFromPgfsm(input: serde_json::Value) -> serde_json::Value {
    // TODO: implement actor logic
    serde_json::json!({ "input": input, "msg": "byeFromPgfsm actor invoked by rust" })
}
