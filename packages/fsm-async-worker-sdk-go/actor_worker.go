// Package asyncworkersdk is the Go worker SDK for the pgfsm Activity Gateway.
//
// A worker process built on it connects to the gateway's sidecar Unix socket,
// registers a set of actors, and serves the invocations the gateway routes to
// them over the pgfsm.sidecargateway.v1.SidecarGatewayService gRPC stream
// (stubs from the pgfsm-proto-codegen Go module). It never opens a database
// connection — that stays in the gateway.
//
// You normally don't write against this package directly: @pgfsm/compiler's
// generate-async-logic writes a small main.go that maps the project's
// generated actor registry into [ActorRegistration]s and calls
// [RunActorWorkerCLI].
//
// Moved here from fsm-compiler-ts's go/worker-sdk-sdk.eta (#370), which used
// to write this whole file into every project as async-worker/go/sdk.go.
//
// Unlike the TypeScript and Python SDKs there's no dynamic loading step: Go
// has no practical runtime mechanism to load a function out of a .go source
// file the way import() or importlib can (Go plugins need exact toolchain
// matching between plugin and host). ActorWorker takes an explicit
// []ActorRegistration built by the binary that uses it, so the actor functions
// are linked into that binary and a missing or mistyped actor fails the build,
// not worker startup.
//
// grpc-go's client stream gives a synchronous-looking Send/Recv pair backed by
// goroutines internally, so unlike the other SDKs there's no push-queue: only
// a mutex around Send (grpc-go client streams don't allow concurrent Send
// calls; Recv is only ever called from Run's goroutine).
package asyncworkersdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	sidecargatewayv1 "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go/sidecargateway/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// DefaultHeartbeatMs is the default heartbeat interval, in milliseconds.
const DefaultHeartbeatMs = 5000

// RegisteredActor is the generated pgfsm.sidecargateway.v1.RegisteredActor
// message: an actor's identity as the gateway sees it.
type RegisteredActor = sidecargatewayv1.RegisteredActor

// ActorHandler is an actor's compiled-in implementation. A returned error is
// reported to the gateway as an INTERNAL invoke error; a panic is recovered
// and reported the same way rather than crashing the worker process.
type ActorHandler func(input any) (any, error)

// ActorRegistration is one actor to register with the gateway: its identity
// (Meta) and its handler. Meta is a pointer because generated protobuf
// messages must not be copied.
type ActorRegistration struct {
	Meta    *RegisteredActor
	Handler ActorHandler
}

// NewActorRegistration builds a registration from the six identity fields the
// compiler's generated registry carries, plus the handler.
func NewActorRegistration(
	parentFsmName, parentFsmVersion, asyncOperationType, asyncOperationName,
	asyncOperationVersion, asyncOperationLanguage string,
	handler ActorHandler,
) ActorRegistration {
	return ActorRegistration{
		Meta: &RegisteredActor{
			ParentFsmName:          parentFsmName,
			ParentFsmVersion:       parentFsmVersion,
			AsyncOperationType:     asyncOperationType,
			AsyncOperationName:     asyncOperationName,
			AsyncOperationVersion:  asyncOperationVersion,
			AsyncOperationLanguage: asyncOperationLanguage,
		},
		Handler: handler,
	}
}

// ActorWorkerOptions configures an [ActorWorker].
type ActorWorkerOptions struct {
	WorkerID          string
	GatewaySocketPath string
	// HeartbeatMs is the heartbeat interval; zero means DefaultHeartbeatMs.
	HeartbeatMs int
}

// ActorKey is the key the gateway's invoke fields are matched against: all six
// identity fields joined with "@", same as the TypeScript/Python/Rust SDKs.
func ActorKey(parentFsmName, parentFsmVersion, asyncOperationType, asyncOperationName, asyncOperationVersion, asyncOperationLanguage string) string {
	return fmt.Sprintf("%s@%s@%s@%s@%s@%s", parentFsmName, parentFsmVersion, asyncOperationType, asyncOperationName, asyncOperationVersion, asyncOperationLanguage)
}

// ActorWorker registers a set of actors with the gateway and serves their
// invocations. Create one with [NewActorWorker].
type ActorWorker struct {
	options    ActorWorkerOptions
	handlers   map[string]ActorHandler
	registered []*RegisteredActor
	logger     *slog.Logger

	stopped atomic.Bool
	// mu guards stream and every Send on it.
	mu     sync.Mutex
	stream sidecargatewayv1.SidecarGatewayService_SessionClient
}

// NewActorWorker returns a worker for registrations. Nothing connects until
// [ActorWorker.Run].
func NewActorWorker(options ActorWorkerOptions, registrations []ActorRegistration) *ActorWorker {
	if options.HeartbeatMs <= 0 {
		options.HeartbeatMs = DefaultHeartbeatMs
	}
	handlers := make(map[string]ActorHandler, len(registrations))
	registered := make([]*RegisteredActor, 0, len(registrations))
	for _, reg := range registrations {
		m := reg.Meta
		handlers[ActorKey(m.GetParentFsmName(), m.GetParentFsmVersion(), m.GetAsyncOperationType(), m.GetAsyncOperationName(), m.GetAsyncOperationVersion(), m.GetAsyncOperationLanguage())] = reg.Handler
		registered = append(registered, m)
	}
	return &ActorWorker{
		options:    options,
		handlers:   handlers,
		registered: registered,
		logger:     slog.Default().With("component", "pgfsm.async_worker_sdk"),
	}
}

// RegisteredActors returns the actors this worker registers, in order.
func (w *ActorWorker) RegisteredActors() []*RegisteredActor {
	return w.registered
}

// Run registers every actor and serves invocations until [ActorWorker.Stop] is
// called or the gateway ends the stream, then closes its connection. A
// shutdown via Stop returns nil.
func (w *ActorWorker) Run() error {
	if len(w.registered) == 0 {
		return errors.New("no actors to register, refusing to start worker")
	}
	if w.stopped.Load() {
		return nil
	}

	conn, err := grpc.NewClient("unix://"+w.options.GatewaySocketPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer conn.Close()

	stream, err := sidecargatewayv1.NewSidecarGatewayServiceClient(conn).Session(context.Background())
	if err != nil {
		return err
	}
	w.mu.Lock()
	w.stream = stream
	w.mu.Unlock()

	if err := w.send(&sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_Register{
			Register: &sidecargatewayv1.Register{
				WorkerId:        w.options.WorkerID,
				Language:        "go",
				ProtocolVersion: "1.0",
				Actors:          w.registered,
			},
		},
	}); err != nil {
		return fmt.Errorf("sending register: %w", err)
	}

	first, err := stream.Recv()
	if err != nil {
		return fmt.Errorf("waiting for register_ack: %w", err)
	}
	ack, ok := first.GetPayload().(*sidecargatewayv1.SessionResponse_RegisterAck)
	if !ok {
		return fmt.Errorf("expected register_ack but got %T", first.GetPayload())
	}
	if !ack.RegisterAck.GetAccepted() {
		w.stopped.Store(true)
		w.closeSend()
		return errors.New("gateway rejected registration")
	}

	w.logger.Info("worker registered actors with the gateway", "worker_id", w.options.WorkerID, "actors", len(w.registered))

	heartbeatDone := make(chan struct{})
	stopHeartbeat := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(time.Duration(w.options.HeartbeatMs) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopHeartbeat:
				return
			case <-ticker.C:
				if w.stopped.Load() {
					return
				}
				_ = w.send(&sidecargatewayv1.SessionRequest{
					Payload: &sidecargatewayv1.SessionRequest_Heartbeat{
						Heartbeat: &sidecargatewayv1.Heartbeat{WorkerId: w.options.WorkerID},
					},
				})
			}
		}
	}()

	err = w.serveLoop(stream)
	w.stopped.Store(true)
	close(stopHeartbeat)
	<-heartbeatDone
	w.closeSend()
	return err
}

// Stop asks the gateway to unregister this worker and ends the session. Safe
// to call from any goroutine (e.g. a signal handler), more than once, and
// before Run has connected.
func (w *ActorWorker) Stop() {
	if w.stopped.Swap(true) {
		return
	}
	_ = w.send(&sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_Unregister{
			Unregister: &sidecargatewayv1.Unregister{WorkerId: w.options.WorkerID},
		},
	})
	// Half-close rather than closing the connection: the gateway sees the
	// unregister and end of stream, ends its side, and Run returns cleanly.
	w.closeSend()
}

func (w *ActorWorker) send(req *sidecargatewayv1.SessionRequest) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stream == nil {
		return errors.New("not connected")
	}
	return w.stream.Send(req)
}

func (w *ActorWorker) closeSend() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stream != nil {
		_ = w.stream.CloseSend()
	}
}

func (w *ActorWorker) serveLoop(stream sidecargatewayv1.SidecarGatewayService_SessionClient) error {
	for {
		resp, err := stream.Recv()
		if err != nil {
			// A clean end of stream, or any error after Stop, is a normal
			// shutdown.
			if errors.Is(err, io.EOF) || w.stopped.Load() {
				return nil
			}
			return err
		}
		switch p := resp.GetPayload().(type) {
		case *sidecargatewayv1.SessionResponse_Invoke:
			w.handleInvoke(p.Invoke)
		case *sidecargatewayv1.SessionResponse_Cancel:
			// Invokes run to completion; nothing to cancel.
		}
	}
}

func (w *ActorWorker) handleInvoke(body *sidecargatewayv1.Invoke) {
	key := ActorKey(body.GetParentFsmName(), body.GetParentFsmVersion(), body.GetAsyncOperationType(), body.GetAsyncOperationName(), body.GetAsyncOperationVersion(), body.GetAsyncOperationLanguage())
	handler, ok := w.handlers[key]
	if !ok {
		w.logger.Warn("invoke for unknown actor", "invoke_id", body.GetInvokeId(), "actor", key)
		w.sendError(body.GetInvokeId(), "NOT_FOUND", fmt.Sprintf("actor not found: %s", key))
		return
	}

	var input any
	if s := body.GetInputJson(); s != "" {
		if err := json.Unmarshal([]byte(s), &input); err != nil {
			w.sendError(body.GetInvokeId(), "INTERNAL", fmt.Sprintf("invalid input_json: %v", err))
			return
		}
	}

	started := time.Now()
	output, err := safeInvoke(handler, input)
	if err != nil {
		w.logger.Error("actor failed", "actor", key, "error", err)
		w.sendError(body.GetInvokeId(), "INTERNAL", err.Error())
		return
	}

	outputJSON, err := json.Marshal(output)
	if err != nil {
		w.sendError(body.GetInvokeId(), "INTERNAL", fmt.Sprintf("output is not JSON-serializable: %v", err))
		return
	}

	_ = w.send(&sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_InvokeResult{
			InvokeResult: &sidecargatewayv1.InvokeResult{
				InvokeId:   body.GetInvokeId(),
				OutputJson: string(outputJSON),
				DurationMs: uint32(time.Since(started).Milliseconds()),
			},
		},
	})
}

func safeInvoke(handler ActorHandler, input any) (output any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return handler(input)
}

func (w *ActorWorker) sendError(invokeID, code, message string) {
	_ = w.send(&sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_InvokeError{
			InvokeError: &sidecargatewayv1.InvokeError{
				InvokeId: invokeID,
				Error: &sidecargatewayv1.InvokeErrorDetail{
					Code:      code,
					Message:   message,
					Retriable: false,
				},
			},
		},
	})
}
