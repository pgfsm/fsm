package actors

// Actor: helloFromPgfsm
func HelloFromPgfsm(input any) (any, error) {
	// TODO: implement actor logic
	return map[string]any{"input": input, "msg": "helloFromPgfsm actor invoked by go"}, nil
}
