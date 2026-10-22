package actors

import "context"

// Actor: CheckReportsTable

// MaxConcurrency is how many invokes of this actor one worker runs at once.
// Above 1, the handler runs on several goroutines at once: guard shared state
// with a sync.Mutex, atomics or channels. Delivery is at-least-once, so the
// handler must also be idempotent: the same invoke can arrive more than once.
const MaxConcurrency = 1

func CheckReportsTable(ctx context.Context, input any) (any, error) {
	// TODO: implement actor logic
	// ctx is cancelled when the gateway cancels this invoke (e.g. its FSM
	// state exited): pass it to anything that takes one.
	return map[string]any{"input": input, "msg": "CheckReportsTable actor invoked by go"}, nil
}
