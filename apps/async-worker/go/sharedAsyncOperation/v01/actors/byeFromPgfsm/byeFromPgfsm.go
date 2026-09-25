package actors

// Actor: byeFromPgfsm
func ByeFromPgfsm(input any) (any, error) {
	// TODO: implement actor logic
	return map[string]any{"input": input, "msg": "byeFromPgfsm actor invoked by go"}, nil
}
