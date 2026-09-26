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
	"testing"
	"time"

	sidecargatewayv1 "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go/sidecargateway/v1"
	"google.golang.org/grpc"
)

const testTimeout = 5 * time.Second

type fakeGateway struct {
	sidecargatewayv1.UnimplementedSidecarGatewayServiceServer
	accept        bool
	closeAfterAck bool
	toWorker      chan *sidecargatewayv1.SessionResponse
	fromWorker    chan *sidecargatewayv1.SessionRequest
}

func (g *fakeGateway) Session(stream sidecargatewayv1.SidecarGatewayService_SessionServer) error {
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
	server := grpc.NewServer()
	sidecargatewayv1.RegisterSidecarGatewayServiceServer(server, g)
	go server.Serve(lis)
	t.Cleanup(server.Stop)
	return g, socket
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
	if err == nil || !strings.Contains(err.Error(), "rejected") {
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

// The gateway ends the stream right after acking, so start returns on its own.
func TestCLIStartServesUntilTheGatewayEndsTheStream(t *testing.T) {
	g, socket := startGateway(t, true, true)
	code := make(chan int, 1)
	go func() {
		code <- runCLI(testRegistrations(), []string{"start", "--gateway-socket", socket, "--worker-id=w-cli"}, "", io.Discard)
	}()
	register := g.nextOf(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetRegister() != nil }).GetRegister()
	if register.GetWorkerId() != "w-cli" {
		t.Fatalf("unexpected worker id %q", register.GetWorkerId())
	}
	select {
	case c := <-code:
		if c != 0 {
			t.Fatalf("start exit code = %d, want 0", c)
		}
	case <-time.After(testTimeout):
		t.Fatal("CLI didn't return")
	}
}
