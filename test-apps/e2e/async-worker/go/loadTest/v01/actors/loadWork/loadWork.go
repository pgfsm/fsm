package actors

// Actor: loadWork — the SPEC-007 acceptance suite's load (#458). Sleeps for
// workMs, then reports which worker processed the message, so the suite can
// tell replicas apart (worker is the pod name in Kubernetes).

import (
	"os"
	"time"
)

// MaxConcurrency is how many invokes of this actor one worker runs at once.
// Above 1, the handler runs on several goroutines at once: guard shared state
// with a sync.Mutex, atomics or channels. Delivery is at-least-once, so the
// handler must also be idempotent: the same invoke can arrive more than once.
const MaxConcurrency = 1

const maxWorkMs = 600_000

func LoadWork(input any) (any, error) {
	fields, _ := input.(map[string]any)
	workMs, _ := fields["workMs"].(float64)
	if workMs < 0 {
		workMs = 0
	} else if workMs > maxWorkMs {
		workMs = maxWorkMs
	}
	time.Sleep(time.Duration(workMs) * time.Millisecond)
	worker, err := os.Hostname()
	if err != nil {
		worker = "unknown"
	}
	return map[string]any{
		"n":        fields["n"],
		"runId":    fields["runId"],
		"worker":   worker,
		"language": "go",
	}, nil
}
