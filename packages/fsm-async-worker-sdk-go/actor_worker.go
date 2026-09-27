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
	"math"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	sidecargatewayv1 "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go/sidecargateway/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// DefaultHeartbeatMs is the default heartbeat interval, in milliseconds.
const DefaultHeartbeatMs = 5000

// Reconnect backoff defaults, in milliseconds (#392).
const (
	DefaultReconnectInitialDelayMs = 250
	DefaultReconnectMaxDelayMs     = 30000
)

// StableSessionMs is how long a session must stay up before the reconnect
// backoff resets, so a gateway that accepts and immediately drops (flapping)
// still backs off instead of being hammered in a tight loop.
const StableSessionMs = 10000

// fatalCodes are gRPC codes that reconnecting can't fix (bad credentials,
// wrong server or protocol): Run fails fast on these rather than retrying
// forever and hiding a misconfiguration behind warnings. Same list in all
// four SDKs.
var fatalCodes = map[codes.Code]bool{
	codes.Unauthenticated:  true,
	codes.PermissionDenied: true,
	codes.Unimplemented:    true,
	codes.InvalidArgument:  true,
}

func isFatal(err error) bool {
	if errors.Is(err, ErrRegistrationRejected) {
		return true
	}
	s, ok := status.FromError(err)
	return ok && fatalCodes[s.Code()]
}

// ErrRegistrationRejected means the gateway explicitly refused this worker's
// registration. [ActorWorker.Run] returns it instead of retrying, since
// reconnecting would just be refused again.
var ErrRegistrationRejected = errors.New("gateway rejected registration")

// ReconnectDelayMs is full-jitter exponential backoff: a random delay in
// [0, min(maxMs, initialMs * 2^(attempt-1))]. Same formula in all four SDKs.
func ReconnectDelayMs(attempt, initialMs, maxMs int) int {
	if attempt < 1 {
		attempt = 1
	}
	ceiling := math.Min(float64(maxMs), float64(initialMs)*math.Pow(2, float64(attempt-1)))
	return int(rand.Float64() * ceiling)
}

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
	// ReconnectInitialDelayMs is the first reconnect backoff step; zero means
	// DefaultReconnectInitialDelayMs.
	ReconnectInitialDelayMs int
	// ReconnectMaxDelayMs caps the backoff; zero means
	// DefaultReconnectMaxDelayMs.
	ReconnectMaxDelayMs int
	// ReconnectMaxAttempts makes Run give up after this many consecutive
	// failed attempts; zero retries forever. A session that fails to
	// register, or registers but ends within StableSessionMs, counts as a
	// failed attempt; a longer one resets the count.
	ReconnectMaxAttempts int
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
	// stopCh is closed by Stop, waking a reconnect backoff early.
	stopCh chan struct{}
	// mu guards stream (the current session's, nil between sessions) and
	// every Send on it.
	mu     sync.Mutex
	stream sidecargatewayv1.SidecarGatewayService_SessionClient
}

// NewActorWorker returns a worker for registrations. Nothing connects until
// [ActorWorker.Run].
func NewActorWorker(options ActorWorkerOptions, registrations []ActorRegistration) *ActorWorker {
	if options.HeartbeatMs <= 0 {
		options.HeartbeatMs = DefaultHeartbeatMs
	}
	if options.ReconnectInitialDelayMs <= 0 {
		options.ReconnectInitialDelayMs = DefaultReconnectInitialDelayMs
	}
	if options.ReconnectMaxDelayMs <= 0 {
		options.ReconnectMaxDelayMs = DefaultReconnectMaxDelayMs
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
		stopCh:     make(chan struct{}),
	}
}

// RegisteredActors returns the actors this worker registers, in order.
func (w *ActorWorker) RegisteredActors() []*RegisteredActor {
	return w.registered
}

// Run registers every actor and serves invocations until [ActorWorker.Stop] is
// called. If the gateway isn't up yet, or a session ends (gateway restart,
// dropped connection), it reconnects with backoff and re-registers (#392). A
// shutdown via Stop returns nil; Run only returns an error for what
// reconnecting can't fix: an empty registry, [ErrRegistrationRejected], a
// fatal gRPC code (Unauthenticated, PermissionDenied, Unimplemented,
// InvalidArgument), or ReconnectMaxAttempts consecutive failed attempts.
func (w *ActorWorker) Run() error {
	if len(w.registered) == 0 {
		return errors.New("no actors to register, refusing to start worker")
	}

	failures := 0
	for !w.stopped.Load() {
		started := time.Now()
		registered, err := w.runSession()
		if isFatal(err) {
			return err
		}
		if w.stopped.Load() {
			return nil
		}

		if registered && time.Since(started) >= StableSessionMs*time.Millisecond {
			failures = 0
		} else {
			failures++
		}
		if err == nil {
			err = errors.New("stream closed")
		}
		if w.options.ReconnectMaxAttempts > 0 && failures >= w.options.ReconnectMaxAttempts {
			return fmt.Errorf("giving up after %d consecutive failed attempt(s) to connect to the gateway: %w", failures, err)
		}

		delay := time.Duration(ReconnectDelayMs(max(failures, 1), w.options.ReconnectInitialDelayMs, w.options.ReconnectMaxDelayMs)) * time.Millisecond
		if registered {
			w.logger.Warn("gateway session ended; reconnecting", "error", err, "delay", delay)
		} else {
			w.logger.Warn("could not connect to the gateway; retrying", "error", err, "delay", delay)
		}
		timer := time.NewTimer(delay)
		select {
		case <-w.stopCh:
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
	return nil
}

// runSession is one connect -> register -> serve cycle. registered reports
// whether the gateway acked; Run resets the backoff only if a registered
// session also lasted StableSessionMs.
func (w *ActorWorker) runSession() (registered bool, err error) {
	conn, err := grpc.NewClient("unix://"+w.options.GatewaySocketPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return false, err
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := sidecargatewayv1.NewSidecarGatewayServiceClient(conn).Session(ctx)
	if err != nil {
		return false, err
	}
	w.mu.Lock()
	w.stream = stream
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		if w.stream == stream {
			w.stream = nil
		}
		w.mu.Unlock()
	}()
	// Stop may have run between the loop's check and the stream being
	// published above, in which case it had no stream to unregister on.
	if w.stopped.Load() {
		return false, nil
	}

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
		return false, fmt.Errorf("sending register: %w", err)
	}

	first, err := stream.Recv()
	if err != nil {
		return false, fmt.Errorf("waiting for register_ack: %w", err)
	}
	ack, ok := first.GetPayload().(*sidecargatewayv1.SessionResponse_RegisterAck)
	if !ok {
		return false, fmt.Errorf("expected register_ack but got %T", first.GetPayload())
	}
	if !ack.RegisterAck.GetAccepted() {
		_ = stream.CloseSend()
		return false, ErrRegistrationRejected
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
				_ = w.send(&sidecargatewayv1.SessionRequest{
					Payload: &sidecargatewayv1.SessionRequest_Heartbeat{
						Heartbeat: &sidecargatewayv1.Heartbeat{WorkerId: w.options.WorkerID},
					},
				})
			}
		}
	}()

	err = w.serveLoop(stream)
	close(stopHeartbeat)
	<-heartbeatDone
	_ = stream.CloseSend()
	return true, err
}

// Stop asks the gateway to unregister this worker and ends the session. Safe
// to call from any goroutine (e.g. a signal handler), more than once, and
// before Run has connected.
func (w *ActorWorker) Stop() {
	if w.stopped.Swap(true) {
		return
	}
	close(w.stopCh)
	_ = w.send(&sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_Unregister{
			Unregister: &sidecargatewayv1.Unregister{WorkerId: w.options.WorkerID},
		},
	})
	// Half-close rather than closing the connection: the gateway sees the
	// unregister and end of stream, ends its side, and Run returns cleanly.
	// Between sessions there's no stream; stopCh wakes Run's backoff instead.
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

	err = w.send(&sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_InvokeResult{
			InvokeResult: &sidecargatewayv1.InvokeResult{
				InvokeId:   body.GetInvokeId(),
				OutputJson: string(outputJSON),
				DurationMs: uint32(time.Since(started).Milliseconds()),
			},
		},
	})
	w.warnIfDropped(err, body.GetInvokeId(), key)
}

// warnIfDropped logs a result that couldn't be sent because the invoke
// outlived its session: it can't go out on a later session (the gateway
// matches results to the connection it sent the invoke on, and has already
// failed it as WORKER_DISCONNECTED).
func (w *ActorWorker) warnIfDropped(err error, invokeID, key string) {
	if err != nil {
		w.logger.Warn("dropping invoke result: its gateway session ended", "invoke_id", invokeID, "actor", key, "error", err)
	}
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
	err := w.send(&sidecargatewayv1.SessionRequest{
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
	w.warnIfDropped(err, invokeID, "")
}
