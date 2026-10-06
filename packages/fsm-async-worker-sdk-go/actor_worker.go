// Package asyncworkersdk is the Go worker SDK for the pgfsm Activity Gateway.
//
// A worker process built on it connects to the gateway's sidecar (over its Unix
// socket, or over TCP with TLS, a bearer token and/or mutual TLS — SPEC-007),
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
// calls; Recv is only ever called from Run's goroutine). Invokes run on their
// own goroutines and send their results on the session they arrived on.
package asyncworkersdk

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand/v2"
	"net"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	sidecargatewayv1 "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go/sidecargateway/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// DefaultHeartbeatMs is the default heartbeat interval, in milliseconds.
const DefaultHeartbeatMs = 5000

// Reconnect backoff defaults, in milliseconds (#392).
const (
	DefaultReconnectInitialDelayMs = 250
	DefaultReconnectMaxDelayMs     = 30000
)

// Defaults for TCP keepalive and the drain on Stop, in milliseconds.
const (
	DefaultKeepaliveIntervalMs = 30000
	DefaultKeepaliveTimeoutMs  = 10000
	DefaultShutdownGraceMs     = 25000
)

// closeWait bounds how long, after the drain, the worker waits for the gateway
// to end its side of the stream.
const closeWait = 5 * time.Second

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

// WithMaxConcurrency sets how many invokes of this actor run at once,
// overriding the worker's MaxConcurrency; 0 (the default) falls back to it,
// then to 1 (SPEC-007). The handler must be safe to run concurrently above 1.
func (r ActorRegistration) WithMaxConcurrency(n uint32) ActorRegistration {
	r.Meta.MaxConcurrency = n
	return r
}

// GatewayAddress is a parsed gateway address: Kind "unix" with Path, or "tcp"
// with URL (no trailing slash) and whether it's TLS.
type GatewayAddress struct {
	Kind string
	Path string
	URL  string
	TLS  bool
}

// target is the host:port of a TCP address.
func (a GatewayAddress) target() string {
	_, rest, _ := strings.Cut(a.URL, "://")
	return rest
}

var tcpAddress = regexp.MustCompile(`^(https?)://[^/]+:\d+/?$`)

// ParseGatewayAddress parses unix:<path>, https://host:port or
// http://host:port.
func ParseGatewayAddress(address string) (GatewayAddress, error) {
	if path, ok := strings.CutPrefix(address, "unix:"); ok && path != "" {
		return GatewayAddress{Kind: "unix", Path: path}, nil
	}
	if m := tcpAddress.FindStringSubmatch(address); m != nil {
		return GatewayAddress{Kind: "tcp", URL: strings.TrimSuffix(address, "/"), TLS: m[1] == "https"}, nil
	}
	return GatewayAddress{}, fmt.Errorf("gateway address must be unix:<path>, https://host:port or http://host:port, got: %s", address)
}

// EffectiveMaxConcurrency is the limit an actor runs under: its own, else the
// worker's, else 1. Zero (or less) means unset for both.
func EffectiveMaxConcurrency(actorMax, workerMax int) int {
	if actorMax > 0 {
		return actorMax
	}
	if workerMax > 0 {
		return workerMax
	}
	return 1
}

// ActorWorkerOptions configures an [ActorWorker].
type ActorWorkerOptions struct {
	WorkerID string
	// GatewaySocketPath is shorthand for GatewayAddress "unix:<path>".
	GatewaySocketPath string
	// GatewayAddress is where the gateway's sidecar listens: unix:<path>,
	// https://host:port (TLS), or http://host:port (the gateway's
	// --insecure-plaintext test mode). Takes precedence over
	// GatewaySocketPath.
	GatewayAddress string
	// CAFile is a PEM CA bundle to trust the gateway's TLS certificate; empty
	// means the system roots.
	CAFile string
	// TokenFile holds the bearer token sent as "authorization: Bearer
	// <token>". Re-read for every session, so a rotated Secret is picked up
	// on reconnect.
	TokenFile string
	// CertFile and KeyFile are a PEM client certificate and key for mutual
	// TLS; re-read for every session.
	CertFile string
	KeyFile  string
	// KeepaliveIntervalMs is the HTTP/2 PING interval on TCP connections; a
	// PING unanswered for KeepaliveTimeoutMs drops the session so the worker
	// reconnects. Zero means DefaultKeepaliveIntervalMs, negative disables.
	// grpc-go raises intervals below 10 s to 10 s. Not used for Unix sockets.
	KeepaliveIntervalMs int
	// KeepaliveTimeoutMs: zero means DefaultKeepaliveTimeoutMs.
	KeepaliveTimeoutMs int
	// MaxConcurrency is how many invokes of each actor run at once, for
	// actors without their own MaxConcurrency. Zero means 1: one at a time,
	// the historical behaviour.
	MaxConcurrency int
	// ShutdownGraceMs is how long in-flight invokes get to finish after Stop
	// before the worker disconnects anyway. Zero means
	// DefaultShutdownGraceMs; negative means don't wait.
	ShutdownGraceMs int
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

type sessionStream = sidecargatewayv1.SidecarGatewayService_SessionClient

var errSessionEnded = errors.New("gateway session ended")

// ActorWorker registers a set of actors with the gateway and serves their
// invocations. Create one with [NewActorWorker].
//
// Invokes run concurrently, each on its own goroutine, up to each actor's
// limit (its own MaxConcurrency, else the worker's, else 1); extra invokes of
// an actor wait for a slot. [ActorWorker.Stop] drains: new invokes are
// refused as retriable (WORKER_DRAINING, so the gateway delivers them again
// elsewhere) while in-flight ones finish, up to ShutdownGraceMs.
type ActorWorker struct {
	options    ActorWorkerOptions
	address    GatewayAddress
	addressErr error
	handlers   map[string]ActorHandler
	// slots holds one counting semaphore per actor key.
	slots      map[string]chan struct{}
	registered []*RegisteredActor
	logger     *slog.Logger

	// stopCh is closed by Stop, waking a reconnect backoff early.
	stopCh chan struct{}
	// drained is closed once the drain after Stop is over.
	drained chan struct{}

	// mu guards stopping and stream (the current session's, nil between
	// sessions and after the drain). It's never held across a Send, so Stop
	// never blocks.
	mu       sync.Mutex
	stopping bool
	stream   sessionStream
	// sendMu serializes Send and CloseSend on the stream (grpc-go allows
	// neither concurrently).
	sendMu sync.Mutex

	inFlight sync.WaitGroup
	// inFlightCount mirrors inFlight, for the drain's log message.
	inFlightCount atomic.Int64
}

// NewActorWorker returns a worker for registrations. Nothing connects until
// [ActorWorker.Run]. An invalid GatewayAddress makes Run fail at once.
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
	if options.KeepaliveIntervalMs == 0 {
		options.KeepaliveIntervalMs = DefaultKeepaliveIntervalMs
	}
	if options.KeepaliveTimeoutMs <= 0 {
		options.KeepaliveTimeoutMs = DefaultKeepaliveTimeoutMs
	}
	if options.ShutdownGraceMs == 0 {
		options.ShutdownGraceMs = DefaultShutdownGraceMs
	}
	address := options.GatewayAddress
	if address == "" {
		address = "unix:" + options.GatewaySocketPath
	}
	parsed, addressErr := ParseGatewayAddress(address)

	handlers := make(map[string]ActorHandler, len(registrations))
	slots := make(map[string]chan struct{}, len(registrations))
	registered := make([]*RegisteredActor, 0, len(registrations))
	for _, reg := range registrations {
		// A copy, so the effective limit doesn't write into the caller's
		// message.
		m := proto.Clone(reg.Meta).(*RegisteredActor)
		limit := EffectiveMaxConcurrency(int(m.GetMaxConcurrency()), options.MaxConcurrency)
		m.MaxConcurrency = uint32(limit)
		key := ActorKey(m.GetParentFsmName(), m.GetParentFsmVersion(), m.GetAsyncOperationType(), m.GetAsyncOperationName(), m.GetAsyncOperationVersion(), m.GetAsyncOperationLanguage())
		handlers[key] = reg.Handler
		slots[key] = make(chan struct{}, limit)
		registered = append(registered, m)
	}
	return &ActorWorker{
		options:    options,
		address:    parsed,
		addressErr: addressErr,
		handlers:   handlers,
		slots:      slots,
		registered: registered,
		logger:     slog.Default().With("component", "pgfsm.async_worker_sdk"),
		stopCh:     make(chan struct{}),
		drained:    make(chan struct{}),
	}
}

// RegisteredActors returns the actors this worker registers, in order, each
// with the effective MaxConcurrency it declares to the gateway.
func (w *ActorWorker) RegisteredActors() []*RegisteredActor {
	return w.registered
}

func (w *ActorWorker) isStopping() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.stopping
}

// Run registers every actor and serves invocations until [ActorWorker.Stop] is
// called, then returns nil once the drain is over. If the gateway isn't up
// yet, or a session ends (gateway restart, dropped connection, max connection
// age), it reconnects with backoff on a new connection and re-registers
// (#392). Run only returns an error for what reconnecting can't fix: an empty
// registry, an invalid gateway address, [ErrRegistrationRejected], a fatal
// gRPC code (Unauthenticated, PermissionDenied, Unimplemented,
// InvalidArgument), or ReconnectMaxAttempts consecutive failed attempts.
func (w *ActorWorker) Run() error {
	if len(w.registered) == 0 {
		return errors.New("no actors to register, refusing to start worker")
	}
	if w.addressErr != nil {
		return w.addressErr
	}

	failures := 0
reconnect:
	for !w.isStopping() {
		started := time.Now()
		registered, err := w.runSession()
		if isFatal(err) {
			return err
		}
		if w.isStopping() {
			break
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
			break reconnect
		case <-timer.C:
		}
	}
	<-w.drained
	return nil
}

// Stop stops gracefully: new invokes are refused as retriable while in-flight
// ones finish (up to ShutdownGraceMs), then the worker unregisters and ends
// its session, and Run returns nil. Stop doesn't block; it's safe to call
// from any goroutine (e.g. a signal handler), more than once, and before Run
// has connected.
func (w *ActorWorker) Stop() {
	w.mu.Lock()
	if w.stopping {
		w.mu.Unlock()
		return
	}
	w.stopping = true
	w.mu.Unlock()
	close(w.stopCh)
	go w.drain()
}

// drain waits for in-flight invokes (up to ShutdownGraceMs), then unregisters
// and half-closes the current session's stream. Half-close rather than
// closing the connection: the gateway sees the unregister and end of stream,
// ends its side, and Run returns cleanly.
func (w *ActorWorker) drain() {
	defer close(w.drained)
	if n := w.inFlightCount.Load(); n > 0 && w.options.ShutdownGraceMs > 0 {
		w.logger.Info("draining in-flight invokes before stopping", "count", n, "grace_ms", w.options.ShutdownGraceMs)
		done := make(chan struct{})
		go func() {
			w.inFlight.Wait()
			close(done)
		}()
		timer := time.NewTimer(time.Duration(w.options.ShutdownGraceMs) * time.Millisecond)
		select {
		case <-done:
			timer.Stop()
		case <-timer.C:
		}
	}

	w.mu.Lock()
	stream := w.stream
	// Results still to come (past the grace period) are dropped, not sent
	// after the half-close.
	w.stream = nil
	w.mu.Unlock()
	if stream == nil {
		return
	}
	w.sendMu.Lock()
	defer w.sendMu.Unlock()
	_ = stream.Send(&sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_Unregister{
			Unregister: &sidecargatewayv1.Unregister{WorkerId: w.options.WorkerID},
		},
	})
	_ = stream.CloseSend()
}

// dial opens a new connection for one session, so a reconnect after the
// gateway's max connection age can reach another replica, and returns the
// authorization value. TLS material and the token are read now, so rotated
// files apply from the next session.
func (w *ActorWorker) dial() (*grpc.ClientConn, string, error) {
	authorization := ""
	if w.options.TokenFile != "" {
		token, err := os.ReadFile(w.options.TokenFile)
		if err != nil {
			return nil, "", err
		}
		authorization = "Bearer " + strings.TrimSpace(string(token))
	}
	if w.address.Kind == "unix" {
		conn, err := grpc.NewClient("unix://"+w.address.Path, grpc.WithTransportCredentials(insecure.NewCredentials()))
		return conn, authorization, err
	}

	var opts []grpc.DialOption
	if w.options.KeepaliveIntervalMs > 0 {
		opts = append(opts, grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                time.Duration(w.options.KeepaliveIntervalMs) * time.Millisecond,
			Timeout:             time.Duration(w.options.KeepaliveTimeoutMs) * time.Millisecond,
			PermitWithoutStream: true,
		}))
	}
	if w.address.TLS {
		config := &tls.Config{MinVersion: tls.VersionTLS12}
		if w.options.CAFile != "" {
			pem, err := os.ReadFile(w.options.CAFile)
			if err != nil {
				return nil, "", err
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(pem) {
				return nil, "", fmt.Errorf("no PEM certificates in %s", w.options.CAFile)
			}
			config.RootCAs = pool
		}
		if w.options.CertFile != "" && w.options.KeyFile != "" {
			cert, err := tls.LoadX509KeyPair(w.options.CertFile, w.options.KeyFile)
			if err != nil {
				return nil, "", err
			}
			config.Certificates = []tls.Certificate{cert}
		}
		if host, _, err := net.SplitHostPort(w.address.target()); err == nil && net.ParseIP(host) == nil {
			config.ServerName = host
		}
		opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(config)))
	} else {
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	}
	conn, err := grpc.NewClient(w.address.target(), opts...)
	return conn, authorization, err
}

// runSession is one connect -> register -> serve cycle. registered reports
// whether the gateway acked; Run resets the backoff only if a registered
// session also lasted StableSessionMs.
func (w *ActorWorker) runSession() (registered bool, err error) {
	conn, authorization, err := w.dial()
	if err != nil {
		return false, err
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if authorization != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", authorization)
	}
	stream, err := sidecargatewayv1.NewSidecarGatewayServiceClient(conn).Session(ctx)
	if err != nil {
		return false, err
	}
	// Published under the lock Stop takes: either Stop came first and no
	// session starts, or the drain finds this stream and closes it.
	w.mu.Lock()
	if w.stopping {
		w.mu.Unlock()
		return false, nil
	}
	w.stream = stream
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		if w.stream == stream {
			w.stream = nil
		}
		w.mu.Unlock()
	}()

	if err := w.sendOn(stream, &sidecargatewayv1.SessionRequest{
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
		if w.isStopping() && errors.Is(err, io.EOF) {
			return false, nil
		}
		return false, fmt.Errorf("waiting for register_ack: %w", err)
	}
	ack, ok := first.GetPayload().(*sidecargatewayv1.SessionResponse_RegisterAck)
	if !ok {
		return false, fmt.Errorf("expected register_ack but got %T", first.GetPayload())
	}
	if !ack.RegisterAck.GetAccepted() {
		w.closeSend(stream)
		return false, ErrRegistrationRejected
	}

	w.logger.Info("worker registered actors with the gateway", "worker_id", w.options.WorkerID, "actors", len(w.registered))

	sessionDone := make(chan struct{})
	defer close(sessionDone)
	// After the drain half-closes the stream, give the gateway closeWait to
	// end its side before cutting the call.
	go func() {
		select {
		case <-w.drained:
			select {
			case <-time.After(closeWait):
				cancel()
			case <-sessionDone:
			}
		case <-sessionDone:
		}
	}()

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
				_ = w.sendOn(stream, &sidecargatewayv1.SessionRequest{
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
	w.closeSend(stream)
	return true, err
}

// sendOn sends on stream if it's still the current session's; a result for
// an invoke that outlived its session gets errSessionEnded instead.
func (w *ActorWorker) sendOn(stream sessionStream, req *sidecargatewayv1.SessionRequest) error {
	w.mu.Lock()
	current := w.stream == stream
	w.mu.Unlock()
	if !current {
		return errSessionEnded
	}
	w.sendMu.Lock()
	defer w.sendMu.Unlock()
	return stream.Send(req)
}

func (w *ActorWorker) closeSend(stream sessionStream) {
	w.sendMu.Lock()
	defer w.sendMu.Unlock()
	_ = stream.CloseSend()
}

func (w *ActorWorker) serveLoop(stream sessionStream) error {
	for {
		resp, err := stream.Recv()
		if err != nil {
			// A clean end of stream, or any error after Stop, is a normal
			// shutdown.
			if errors.Is(err, io.EOF) || w.isStopping() {
				return nil
			}
			return err
		}
		p, ok := resp.GetPayload().(*sidecargatewayv1.SessionResponse_Invoke)
		if !ok {
			// Cancel: invokes run to completion; nothing to cancel.
			continue
		}
		w.mu.Lock()
		draining := w.stopping
		if !draining {
			w.inFlight.Add(1)
			w.inFlightCount.Add(1)
		}
		w.mu.Unlock()
		if draining {
			// Refused as retriable, so the gateway leaves the message on its
			// queue for another worker (#396).
			w.sendError(stream, p.Invoke.GetInvokeId(), "", "WORKER_DRAINING", "worker is shutting down", true)
			continue
		}
		// Not run inline: invokes run concurrently, each actor bounded by
		// its own slots (see handleInvoke).
		go func(body *sidecargatewayv1.Invoke) {
			defer func() {
				w.inFlightCount.Add(-1)
				w.inFlight.Done()
			}()
			w.handleInvoke(stream, body)
		}(p.Invoke)
	}
}

func (w *ActorWorker) handleInvoke(stream sessionStream, body *sidecargatewayv1.Invoke) {
	key := ActorKey(body.GetParentFsmName(), body.GetParentFsmVersion(), body.GetAsyncOperationType(), body.GetAsyncOperationName(), body.GetAsyncOperationVersion(), body.GetAsyncOperationLanguage())
	handler, ok := w.handlers[key]
	slots := w.slots[key]
	if !ok {
		w.logger.Warn("invoke for unknown actor", "invoke_id", body.GetInvokeId(), "actor", key)
		w.sendError(stream, body.GetInvokeId(), key, "NOT_FOUND", fmt.Sprintf("actor not found: %s", key), false)
		return
	}

	var input any
	if s := body.GetInputJson(); s != "" {
		if err := json.Unmarshal([]byte(s), &input); err != nil {
			w.sendError(stream, body.GetInvokeId(), key, "INTERNAL", fmt.Sprintf("invalid input_json: %v", err), false)
			return
		}
	}

	// Never run more of this actor than declared, even if the gateway sends
	// more (after its own invoke timeout, or through a direct Invoke() RPC).
	slots <- struct{}{}
	defer func() { <-slots }()

	started := time.Now()
	output, err := safeInvoke(handler, input)
	if err != nil {
		w.logger.Error("actor failed", "actor", key, "error", err)
		w.sendError(stream, body.GetInvokeId(), key, "INTERNAL", err.Error(), false)
		return
	}

	outputJSON, err := json.Marshal(output)
	if err != nil {
		w.sendError(stream, body.GetInvokeId(), key, "INTERNAL", fmt.Sprintf("output is not JSON-serializable: %v", err), false)
		return
	}

	err = w.sendOn(stream, &sidecargatewayv1.SessionRequest{
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

func (w *ActorWorker) sendError(stream sessionStream, invokeID, key, code, message string, retriable bool) {
	err := w.sendOn(stream, &sidecargatewayv1.SessionRequest{
		Payload: &sidecargatewayv1.SessionRequest_InvokeError{
			InvokeError: &sidecargatewayv1.InvokeError{
				InvokeId: invokeID,
				Error: &sidecargatewayv1.InvokeErrorDetail{
					Code:      code,
					Message:   message,
					Retriable: retriable,
				},
			},
		},
	})
	w.warnIfDropped(err, invokeID, key)
}
