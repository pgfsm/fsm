package asyncworkersdk

// ActorWorker and the CLI's start path end to end against an in-process
// SidecarGatewayService over a real Unix socket: register, heartbeat,
// invoke, a failing and a panicking handler surfacing as INTERNAL, an unknown
// actor as NOT_FOUND, unregister on Stop, and a rejected registration. The
// fake gateway is a grpc-go server built from the same pgfsm-proto-codegen
// stubs; same coverage as the Python and Rust SDKs' tests.

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	sidecargatewayv1 "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go/sidecargateway/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const testTimeout = 5 * time.Second

type fakeGateway struct {
	sidecargatewayv1.UnimplementedSidecarGatewayServiceServer
	accept        bool
	closeAfterAck bool
	toWorker      chan *sidecargatewayv1.SessionResponse
	fromWorker    chan *sidecargatewayv1.SessionRequest
	server        *grpc.Server
	// abortWith, when set, fails every session with this code.
	abortWith codes.Code
	sessions  atomic.Int32
}

func (g *fakeGateway) Session(stream sidecargatewayv1.SidecarGatewayService_SessionServer) error {
	g.sessions.Add(1)
	if g.abortWith != codes.OK {
		return status.Error(g.abortWith, "refused by test gateway")
	}
	recvDone := make(chan struct{})
	registered := make(chan struct{}, 1)
	go func() {
		defer close(recvDone)
		for {
			req, err := stream.Recv()
			if err != nil {
				return
			}
			g.fromWorker <- req
			if req.GetRegister() != nil {
				registered <- struct{}{}
			}
		}
	}()

	select {
	case <-registered:
	case <-time.After(testTimeout):
		return errors.New("no register")
	}
	if err := stream.Send(&sidecargatewayv1.SessionResponse{
		Payload: &sidecargatewayv1.SessionResponse_RegisterAck{RegisterAck: &sidecargatewayv1.RegisterAck{Accepted: g.accept}},
	}); err != nil {
		return err
	}
	if !g.accept || g.closeAfterAck {
		return nil // ends the stream
	}
	for {
		select {
		case resp := <-g.toWorker:
			if err := stream.Send(resp); err != nil {
				return err
			}
		case <-recvDone:
			return nil // the worker half-closed its side
		}
	}
}

func startGateway(t *testing.T, accept, closeAfterAck bool) (*fakeGateway, string) {
	t.Helper()
	// AF_UNIX paths are capped at ~104 bytes on macOS, so keep it short.
	dir, err := os.MkdirTemp("/tmp", "pgfsm-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "gw.sock")
	return serveGateway(t, socket, accept, closeAfterAck), socket
}

// serveGateway serves a fresh fake gateway on socket (e.g. to restart one).
func serveGateway(t *testing.T, socket string, accept, closeAfterAck bool) *fakeGateway {
	t.Helper()
	_ = os.Remove(socket)
	lis, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	g := &fakeGateway{
		accept:        accept,
		closeAfterAck: closeAfterAck,
		toWorker:      make(chan *sidecargatewayv1.SessionResponse, 16),
		fromWorker:    make(chan *sidecargatewayv1.SessionRequest, 64),
	}
	g.server = grpc.NewServer()
	sidecargatewayv1.RegisterSidecarGatewayServiceServer(g.server, g)
	go g.server.Serve(lis)
	t.Cleanup(g.server.Stop)
	return g
}

// nextOf returns the next message from the worker matching want, skipping
// others (e.g. heartbeats).
func (g *fakeGateway) nextOf(t *testing.T, want func(*sidecargatewayv1.SessionRequest) bool) *sidecargatewayv1.SessionRequest {
	t.Helper()
	deadline := time.After(testTimeout)
	for {
		select {
		case req := <-g.fromWorker:
			if want(req) {
				return req
			}
		case <-deadline:
			t.Fatal("timed out waiting for a message from the worker")
		}
	}
}

func (g *fakeGateway) invoke(invokeID, name string, input any) {
	b, _ := json.Marshal(input)
	g.toWorker <- &sidecargatewayv1.SessionResponse{
		Payload: &sidecargatewayv1.SessionResponse_Invoke{Invoke: &sidecargatewayv1.Invoke{
			InvokeId:               invokeID,
			ParentFsmName:          "creditCheck",
			ParentFsmVersion:       "v01",
			AsyncOperationType:     "internalAsyncOperation",
			AsyncOperationName:     name,
			AsyncOperationVersion:  "v01",
			AsyncOperationLanguage: "go",
			InputJson:              string(b),
		}},
	}
}

func testRegistrations() []ActorRegistration {
	reg := func(name string, h ActorHandler) ActorRegistration {
		return NewActorRegistration("creditCheck", "v01", "internalAsyncOperation", name, "v01", "go", h)
	}
	return []ActorRegistration{
		reg("checkBureau", func(input any) (any, error) {
			return map[string]any{"input": input, "msg": "checkBureau actor invoked by go"}, nil
		}),
		reg("failing", func(any) (any, error) { return nil, errors.New("boom") }),
		reg("panicking", func(any) (any, error) { panic("kaboom") }),
	}
}

func TestRegistersServesInvokesAndUnregistersOnStop(t *testing.T) {
	g, socket := startGateway(t, true, false)
	worker := NewActorWorker(ActorWorkerOptions{WorkerID: "w-test", GatewaySocketPath: socket, HeartbeatMs: 50}, testRegistrations())
	runErr := make(chan error, 1)
	go func() { runErr <- worker.Run() }()

	register := g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetRegister() != nil }).GetRegister()
	if register.GetWorkerId() != "w-test" || register.GetLanguage() != "go" || len(register.GetActors()) != 3 {
		t.Fatalf("unexpected register: %v", register)
	}

	g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetHeartbeat() != nil })

	g.invoke("i-1", "checkBureau", map[string]any{"applicant": "a1"})
	result := g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetInvokeResult() != nil }).GetInvokeResult()
	var output map[string]any
	if err := json.Unmarshal([]byte(result.GetOutputJson()), &output); err != nil {
		t.Fatal(err)
	}
	if result.GetInvokeId() != "i-1" || output["input"].(map[string]any)["applicant"] != "a1" {
		t.Fatalf("unexpected result: %v", result)
	}

	for _, c := range []struct{ id, name, code, message string }{
		{"i-2", "failing", "INTERNAL", "boom"},
		{"i-3", "panicking", "INTERNAL", "panic: kaboom"},
		{"i-4", "noSuchActor", "NOT_FOUND", "actor not found"},
	} {
		g.invoke(c.id, c.name, nil)
		invokeErr := g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetInvokeError() != nil }).GetInvokeError()
		if invokeErr.GetInvokeId() != c.id || invokeErr.GetError().GetCode() != c.code || !strings.Contains(invokeErr.GetError().GetMessage(), c.message) {
			t.Fatalf("%s: unexpected invoke error: %v", c.name, invokeErr)
		}
	}

	worker.Stop()
	unregister := g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetUnregister() != nil }).GetUnregister()
	if unregister.GetWorkerId() != "w-test" {
		t.Fatalf("unexpected unregister: %v", unregister)
	}

	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run() after Stop() returned %v, want nil", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Run() didn't return after Stop()")
	}
}

func TestRejectedRegistrationIsAnError(t *testing.T) {
	_, socket := startGateway(t, false, false)
	worker := NewActorWorker(ActorWorkerOptions{WorkerID: "w-rejected", GatewaySocketPath: socket}, testRegistrations())
	err := worker.Run()
	if !errors.Is(err, ErrRegistrationRejected) {
		t.Fatalf("Run() = %v, want a rejection error", err)
	}
}

func TestEmptyRegistryRefusesToRun(t *testing.T) {
	if err := NewActorWorker(ActorWorkerOptions{GatewaySocketPath: "/nonexistent/gw.sock"}, nil).Run(); err == nil {
		t.Fatal("Run() with no actors should fail")
	}
}

func TestStopBeforeRunIsSafe(t *testing.T) {
	worker := NewActorWorker(ActorWorkerOptions{GatewaySocketPath: "/nonexistent/gw.sock"}, testRegistrations())
	worker.Stop()
	worker.Stop()
	if err := worker.Run(); err != nil {
		t.Fatalf("Run() after Stop() = %v, want nil", err)
	}
}

// The gateway ending the stream isn't the end of the worker: it reconnects and
// registers again. With the gateway then gone for good,
// --reconnect-max-attempts bounds how long start keeps trying.
func TestCLIStartReconnectsThenExitsAfterMaxReconnectAttempts(t *testing.T) {
	g, socket := startGateway(t, true, true)
	code := make(chan int, 1)
	go func() {
		code <- runCLI(testRegistrations(), []string{
			"start", "--gateway-socket", socket, "--worker-id=w-cli",
			"--reconnect-initial-delay-ms", "10", "--reconnect-max-attempts", "2",
		}, "", io.Discard)
	}()
	isRegister := func(r *sidecargatewayv1.SessionRequest) bool { return r.GetRegister() != nil }
	if id := g.nextOf(t, isRegister).GetRegister().GetWorkerId(); id != "w-cli" {
		t.Fatalf("unexpected worker id %q", id)
	}
	g.nextOf(t, isRegister) // re-registered after the gateway ended the stream
	g.server.Stop()
	select {
	case c := <-code:
		if c != 1 {
			t.Fatalf("start exit code = %d, want 1", c)
		}
	case <-time.After(testTimeout):
		t.Fatal("CLI didn't return")
	}
}

// Reconnect (#392): the worker waits for a gateway that isn't up yet,
// re-registers after the gateway restarts, and only gives up when told to.

func fastReconnect(workerID, socket string) ActorWorkerOptions {
	return ActorWorkerOptions{
		WorkerID:                workerID,
		GatewaySocketPath:       socket,
		HeartbeatMs:             50,
		ReconnectInitialDelayMs: 10,
		ReconnectMaxDelayMs:     50,
	}
}

func runInBackground(worker *ActorWorker) chan error {
	done := make(chan error, 1)
	go func() { done <- worker.Run() }()
	return done
}

func stopAndWait(t *testing.T, worker *ActorWorker, done chan error) {
	t.Helper()
	worker.Stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() = %v, want nil", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Run() didn't return after Stop()")
	}
}

func TestWaitsForAGatewayThatStartsAfterIt(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "pgfsm-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "gw.sock")

	worker := NewActorWorker(fastReconnect("w-early", socket), testRegistrations())
	done := runInBackground(worker)
	time.Sleep(100 * time.Millisecond) // a few attempts fail against the missing socket

	g := serveGateway(t, socket, true, false)
	g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetRegister() != nil })
	g.invoke("inv-early", "checkBureau", map[string]any{"n": 1})
	g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetInvokeResult() != nil })
	stopAndWait(t, worker, done)
}

func TestReRegistersAfterTheGatewayRestarts(t *testing.T) {
	first, socket := startGateway(t, true, false)
	worker := NewActorWorker(fastReconnect("w-restart", socket), testRegistrations())
	done := runInBackground(worker)
	first.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetRegister() != nil })
	first.server.Stop() // drops the live session, like a crash

	second := serveGateway(t, socket, true, false)
	if id := second.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetRegister() != nil }).GetRegister().GetWorkerId(); id != "w-restart" {
		t.Fatalf("unexpected worker id %q", id)
	}
	second.invoke("inv-restart", "checkBureau", map[string]any{"n": 2})
	result := second.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetInvokeResult() != nil }).GetInvokeResult()
	if result.GetInvokeId() != "inv-restart" {
		t.Fatalf("unexpected invoke id %q", result.GetInvokeId())
	}
	stopAndWait(t, worker, done)
}

func TestGivesUpAfterMaxReconnectAttempts(t *testing.T) {
	options := fastReconnect("w-none", "/nonexistent/gw.sock")
	options.ReconnectMaxAttempts = 3
	err := NewActorWorker(options, testRegistrations()).Run()
	if err == nil || !strings.Contains(err.Error(), "giving up after 3 consecutive failed attempt") {
		t.Fatalf("Run() = %v, want a giving-up error", err)
	}
}

func TestStopInterruptsTheReconnectBackoff(t *testing.T) {
	options := fastReconnect("w-stop", "/nonexistent/gw.sock")
	options.ReconnectInitialDelayMs = 60_000
	options.ReconnectMaxDelayMs = 60_000
	worker := NewActorWorker(options, testRegistrations())
	done := runInBackground(worker)
	time.Sleep(200 * time.Millisecond)
	started := time.Now()
	stopAndWait(t, worker, done)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Stop() took %v to end the backoff", elapsed)
	}
}

func TestReconnectDelayIsFullJitterUnderTheCappedExponential(t *testing.T) {
	for attempt := 1; attempt <= 12; attempt++ {
		ceiling := min(30_000, 250*(1<<(attempt-1)))
		for range 50 {
			if d := ReconnectDelayMs(attempt, 250, 30_000); d < 0 || d >= ceiling {
				t.Fatalf("attempt %d: delay %d outside [0, %d)", attempt, d, ceiling)
			}
		}
	}
}

func TestFailsFastOnUnauthenticated(t *testing.T) {
	g, socket := startGateway(t, true, false)
	g.abortWith = codes.Unauthenticated
	err := NewActorWorker(fastReconnect("w-unauth", socket), testRegistrations()).Run()
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("Run() = %v, want Unauthenticated", err)
	}
	if n := g.sessions.Load(); n != 1 {
		t.Fatalf("sessions = %d, want 1 (no retry)", n)
	}
}

func TestFlappingGatewayCountsTowardReconnectMaxAttempts(t *testing.T) {
	g, socket := startGateway(t, true, true)
	options := fastReconnect("w-flap", socket)
	options.ReconnectMaxAttempts = 3
	err := NewActorWorker(options, testRegistrations()).Run()
	if err == nil || !strings.Contains(err.Error(), "giving up after 3 consecutive failed attempt") {
		t.Fatalf("Run() = %v, want a giving-up error", err)
	}
	if n := g.sessions.Load(); n != 3 {
		t.Fatalf("sessions = %d, want 3", n)
	}
}
