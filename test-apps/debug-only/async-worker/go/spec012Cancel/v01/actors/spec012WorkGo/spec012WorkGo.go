package actors

import (
	"context"
	"os"
	"time"
)

// Actor: spec012WorkGo — SPEC-012's end-to-end test (#545). Works for up to
// 5s, unless the gateway cancels it: then it stops before its side effect,
// writing the marker file at input["markerPath"].

// MaxConcurrency is how many invokes of this actor one worker runs at once.
const MaxConcurrency = 4

func Spec012WorkGo(ctx context.Context, input any) (any, error) {
	select {
	case <-time.After(5 * time.Second):
	case <-ctx.Done():
		return nil, context.Cause(ctx) // cancelled: stop here, no side effect
	}
	if fields, ok := input.(map[string]any); ok {
		if path, ok := fields["markerPath"].(string); ok && path != "" {
			if err := os.WriteFile(path, []byte("go"), 0o644); err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{"done": true, "language": "go"}, nil
}
