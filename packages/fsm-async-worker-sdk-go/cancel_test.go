package asyncworkersdk

// SPEC-012 (g), #543: every handler gets a context, and the worker honours
// Cancel. Against the same fake gateway as actor_worker_test.go: a Cancel
// cancels the invoke's context with the reason as its cause, an error after
// it is reported as CANCELLED and a return as the result, the session ending
// cancels every running invoke with SHUTDOWN, an unknown invoke's Cancel is
// ignored, one still waiting for its slot never runs, and the worker sends
// protocol 2.0 and exits 1 on a rejected registration.

import (
	"context"
	"io"
	"sync/atomic"
	"testing"
	"time"

	sidecargatewayv1 "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go/sidecargateway/v1"
)

// cancelHandlers waits for its context and then fails ("waitThenFail") or
// returns anyway ("waitThenReturn"), reporting each cancel reason it saw.
func cancelHandlers(started *atomic.Int32, reasons chan CancelReason) []ActorRegistration {
	wait := func(ctx context.Context) {
		started.Add(1)
		<-ctx.Done()
		reason, _ := CancelReasonOf(ctx)
		reasons <- reason
	}
	reg := func(name string, h ActorHandler) ActorRegistration {
		return NewActorRegistration("creditCheck", "v01", "internalAsyncOperation", name, "v01", "go", h)
	}
	return []ActorRegistration{
		reg("waitThenFail", func(ctx context.Context, _ any) (any, error) {
			wait(ctx)
			return nil, context.Cause(ctx)
		}),
		reg("waitThenReturn", func(ctx context.Context, _ any) (any, error) {
			wait(ctx)
			return map[string]any{"finishedAnyway": true}, nil
		}),
	}
}

func (g *fakeGateway) cancel(invokeID string, reason CancelReason) {
	g.toWorker <- &sidecargatewayv1.SessionResponse{
		Payload: &sidecargatewayv1.SessionResponse_Cancel{Cancel: &sidecargatewayv1.Cancel{InvokeId: invokeID, Reason: reason}},
	}
}

func isReply(r *sidecargatewayv1.SessionRequest) bool {
	return r.GetInvokeResult() != nil || r.GetInvokeError() != nil
}

func waitStarted(t *testing.T, started *atomic.Int32, n int32) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for started.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("only %d handler(s) started, want %d", started.Load(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func nextReason(t *testing.T, reasons chan CancelReason) CancelReason {
	t.Helper()
	select {
	case r := <-reasons:
		return r
	case <-time.After(testTimeout):
		t.Fatal("the handler's context was never cancelled")
		return CancelReasonUnspecified
	}
}

func TestSendsProtocol2AndCancelReasonsMatchTheProto(t *testing.T) {
	if SidecarProtocolVersion != "2.0" {
		t.Fatalf("SidecarProtocolVersion = %q", SidecarProtocolVersion)
	}
	if CancelReasonStateExited != 1 || CancelReasonTimeout != 2 || CancelReasonShutdown != 3 {
		t.Fatal("CancelReason values drifted from the proto")
	}
	g, socket := startGateway(t, true, false)
	worker := NewActorWorker(fastReconnect("w-proto", socket), testRegistrations())
	done := runInBackground(worker)
	defer stopAndWait(t, worker, done)
	register := g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetRegister() != nil }).GetRegister()
	if register.GetProtocolVersion() != "2.0" {
		t.Fatalf("protocol_version = %q, want 2.0", register.GetProtocolVersion())
	}
}

func TestCancelCancelsTheContextAndAnErrorAfterItIsCancelled(t *testing.T) {
	g, socket := startGateway(t, true, false)
	var started atomic.Int32
	reasons := make(chan CancelReason, 4)
	options := fastReconnect("w-cancel", socket)
	options.MaxConcurrency = 2
	worker := NewActorWorker(options, cancelHandlers(&started, reasons))
	done := runInBackground(worker)
	defer stopAndWait(t, worker, done)

	g.invoke("fail", "waitThenFail", nil)
	waitStarted(t, &started, 1)
	g.cancel("fail", CancelReasonStateExited)
	if r := nextReason(t, reasons); r != CancelReasonStateExited {
		t.Fatalf("cause reason = %v, want STATE_EXITED", r)
	}
	reply := g.nextOf(t, isReply)
	if reply.GetInvokeError().GetInvokeId() != "fail" || reply.GetInvokeError().GetError().GetCode() != "CANCELLED" {
		t.Fatalf("unexpected reply: %v", reply)
	}

	// A return after the cancel is still the result.
	g.invoke("ret", "waitThenReturn", nil)
	waitStarted(t, &started, 2)
	g.cancel("ret", CancelReasonTimeout)
	if r := nextReason(t, reasons); r != CancelReasonTimeout {
		t.Fatalf("cause reason = %v, want TIMEOUT", r)
	}
	reply = g.nextOf(t, isReply)
	if reply.GetInvokeResult().GetInvokeId() != "ret" {
		t.Fatalf("unexpected reply: %v", reply)
	}
}

func TestTheSessionEndingCancelsRunningInvokesWithShutdown(t *testing.T) {
	g, socket := startGateway(t, true, false)
	var started atomic.Int32
	reasons := make(chan CancelReason, 4)
	options := fastReconnect("w-end", socket)
	options.MaxConcurrency = 2
	worker := NewActorWorker(options, cancelHandlers(&started, reasons))
	done := runInBackground(worker)
	defer stopAndWait(t, worker, done)

	g.invoke("a", "waitThenFail", nil)
	g.invoke("b", "waitThenReturn", nil)
	waitStarted(t, &started, 2)
	close(g.end)
	for range 2 {
		if r := nextReason(t, reasons); r != CancelReasonShutdown {
			t.Fatalf("cause reason = %v, want SHUTDOWN", r)
		}
	}
}

func TestAnUnknownCancelIsIgnoredAndAQueuedInvokeNeverRuns(t *testing.T) {
	g, socket := startGateway(t, true, false)
	var started atomic.Int32
	reasons := make(chan CancelReason, 4)
	// One slot: "second" waits behind "first".
	worker := NewActorWorker(fastReconnect("w-queued", socket), cancelHandlers(&started, reasons))
	done := runInBackground(worker)
	defer stopAndWait(t, worker, done)

	g.cancel("unknown", CancelReasonStateExited)
	g.invoke("first", "waitThenReturn", nil)
	waitStarted(t, &started, 1)
	g.invoke("second", "waitThenReturn", nil)
	// Let it reach the slot wait before cancelling it.
	time.Sleep(50 * time.Millisecond)
	g.cancel("second", CancelReasonStateExited)
	reply := g.nextOf(t, isReply)
	if reply.GetInvokeError().GetInvokeId() != "second" || reply.GetInvokeError().GetError().GetCode() != "CANCELLED" {
		t.Fatalf("unexpected reply: %v", reply)
	}

	g.cancel("first", CancelReasonTimeout)
	reply = g.nextOf(t, isReply)
	if reply.GetInvokeResult().GetInvokeId() != "first" {
		t.Fatalf("unexpected reply: %v", reply)
	}
	if n := started.Load(); n != 1 {
		t.Fatalf("%d handlers started, want 1", n)
	}
}

func TestCLIExits1OnARejectedRegistration(t *testing.T) {
	g, socket := startGateway(t, false, false)
	code := runCLI(testRegistrations(), []string{"start", "--gateway-socket", socket}, "", io.Discard)
	if code != 1 {
		t.Fatalf("start exit code = %d, want 1", code)
	}
	if n := g.sessions.Load(); n != 1 {
		t.Fatalf("%d sessions, want 1 (no reconnect)", n)
	}
}
