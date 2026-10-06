package asyncworkersdk

// SPEC-007 worker side, over real TCP sockets: TLS + bearer token (and token
// rotation), mutual TLS, an untrusted server, plaintext test mode,
// concurrency (worker-wide and per actor, with precedence), graceful drain,
// and reconnecting after the server's max connection age.
//
// The gateway here is a grpc-go server built from the same stubs (TLS/mTLS
// via credentials.NewTLS, max age via keepalive.ServerParameters), so the
// tests need no Deno gateway. It checks the bearer token the way the real one
// does: missing or wrong -> Unauthenticated before the Register is read. TLS
// fixtures are made by openssl at test time, so no key is committed. Same
// coverage as the Python and Rust SDKs' transport tests.

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	sidecargatewayv1 "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go/sidecargateway/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// --- TLS fixtures -------------------------------------------------------------

// makeTestTLS writes a CA, a server certificate for localhost/127.0.0.1 and a
// client certificate (mutual TLS), all signed by that CA, into a temp dir.
func makeTestTLS(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	openssl := func(args ...string) {
		cmd := exec.Command("openssl", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("openssl %s failed: %v\n%s", args[0], err, out)
		}
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
		"-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=pgfsm-test-ca")
	openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key",
		"-out", "server.csr", "-subj", "/CN=localhost")
	write("san.ext", "subjectAltName=DNS:localhost,IP:127.0.0.1\n")
	openssl("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
		"-CAcreateserial", "-days", "1", "-out", "server.crt", "-extfile", "san.ext")
	openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key",
		"-out", "client.csr", "-subj", "/CN=pgfsm-test-worker")
	// An extension makes OpenSSL 3.0 (Ubuntu 24.04, CI) issue a v3
	// certificate rather than v1.
	write("client.ext", "extendedKeyUsage=clientAuth\n")
	openssl("x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
		"-CAcreateserial", "-days", "1", "-out", "client.crt", "-extfile", "client.ext")
	return dir
}

// --- Fake gateway ---------------------------------------------------------------

// tcpGateway plays the gateway's side of each Session: checks the token, acks
// the Register, then relays what invoke() queues to the latest session and
// records everything the worker sends on fromWorker.
type tcpGateway struct {
	sidecargatewayv1.UnimplementedSidecarGatewayServiceServer
	token string

	mu             sync.Mutex
	registers      []*sidecargatewayv1.Register
	authorizations []string
	current        chan *sidecargatewayv1.SessionResponse

	fromWorker chan *sidecargatewayv1.SessionRequest
	url        string
}

func (g *tcpGateway) Session(stream sidecargatewayv1.SidecarGatewayService_SessionServer) error {
	md, _ := metadata.FromIncomingContext(stream.Context())
	authorization := strings.Join(md.Get("authorization"), ",")
	g.mu.Lock()
	g.authorizations = append(g.authorizations, authorization)
	g.mu.Unlock()
	if g.token != "" && authorization != "Bearer "+g.token {
		return status.Error(codes.Unauthenticated, "missing or invalid bearer token")
	}
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	out := make(chan *sidecargatewayv1.SessionResponse, 16)
	g.mu.Lock()
	g.current = out
	g.registers = append(g.registers, first.GetRegister())
	g.mu.Unlock()
	if err := stream.Send(&sidecargatewayv1.SessionResponse{
		Payload: &sidecargatewayv1.SessionResponse_RegisterAck{RegisterAck: &sidecargatewayv1.RegisterAck{Accepted: true}},
	}); err != nil {
		return err
	}
	recvDone := make(chan struct{})
	go func() {
		defer close(recvDone)
		for {
			req, err := stream.Recv()
			if err != nil {
				return
			}
			g.fromWorker <- req
		}
	}()
	for {
		select {
		case resp := <-out:
			if err := stream.Send(resp); err != nil {
				return err
			}
		case <-recvDone:
			return nil // the worker ended its stream: end ours too
		}
	}
}

type serveOptions struct {
	tlsDir           string // empty: plaintext
	mtls             bool
	token            string
	maxConnectionAge time.Duration
}

func startTCPGateway(t *testing.T, o serveOptions) *tcpGateway {
	t.Helper()
	g := &tcpGateway{token: o.token, fromWorker: make(chan *sidecargatewayv1.SessionRequest, 64)}
	var opts []grpc.ServerOption
	if o.maxConnectionAge > 0 {
		opts = append(opts, grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionAge:      o.maxConnectionAge,
			MaxConnectionAgeGrace: 200 * time.Millisecond,
		}))
	}
	scheme := "http"
	if o.tlsDir != "" {
		cert, err := tls.LoadX509KeyPair(filepath.Join(o.tlsDir, "server.crt"), filepath.Join(o.tlsDir, "server.key"))
		if err != nil {
			t.Fatal(err)
		}
		config := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13}
		if o.mtls {
			pem, _ := os.ReadFile(filepath.Join(o.tlsDir, "ca.crt"))
			pool := x509.NewCertPool()
			pool.AppendCertsFromPEM(pem)
			config.ClientCAs = pool
			config.ClientAuth = tls.RequireAndVerifyClientCert
		}
		opts = append(opts, grpc.Creds(credentials.NewTLS(config)))
		scheme = "https"
	}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer(opts...)
	sidecargatewayv1.RegisterSidecarGatewayServiceServer(server, g)
	go server.Serve(lis)
	t.Cleanup(server.Stop)
	g.url = fmt.Sprintf("%s://%s", scheme, lis.Addr().String())
	return g
}

func (g *tcpGateway) registerCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.registers)
}

func (g *tcpGateway) register(i int) *sidecargatewayv1.Register {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.registers[i]
}

func (g *tcpGateway) seenAuthorizations() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.authorizations...)
}

func (g *tcpGateway) invoke(t *testing.T, invokeID, name string, n int) {
	t.Helper()
	g.mu.Lock()
	out := g.current
	g.mu.Unlock()
	if out == nil {
		t.Fatal("no live session")
	}
	b, _ := json.Marshal(map[string]int{"n": n})
	out <- &sidecargatewayv1.SessionResponse{
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

func (g *tcpGateway) next(t *testing.T, want func(*sidecargatewayv1.SessionRequest) bool) *sidecargatewayv1.SessionRequest {
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

func (g *tcpGateway) result(t *testing.T) *sidecargatewayv1.InvokeResult {
	t.Helper()
	return g.next(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetInvokeResult() != nil }).GetInvokeResult()
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// --- Workers ----------------------------------------------------------------------

func goActor(name string, handler ActorHandler) ActorRegistration {
	return NewActorRegistration("creditCheck", "v01", "internalAsyncOperation", name, "v01", "go", handler)
}

func doubleActor() ActorRegistration {
	return goActor("double", func(input any) (any, error) {
		return map[string]any{"doubled": input.(map[string]any)["n"].(float64) * 2}, nil
	})
}

func tcpOptions(url string) ActorWorkerOptions {
	return ActorWorkerOptions{
		WorkerID:                "w-test",
		GatewayAddress:          url,
		HeartbeatMs:             50,
		ReconnectInitialDelayMs: 20,
		ReconnectMaxDelayMs:     100,
	}
}

// startWorker runs a worker until the returned stop function, which asserts
// that Run returned nil.
func startWorker(t *testing.T, options ActorWorkerOptions, registrations ...ActorRegistration) (*ActorWorker, func()) {
	t.Helper()
	worker := NewActorWorker(options, registrations)
	done := make(chan error, 1)
	go func() { done <- worker.Run() }()
	return worker, func() {
		t.Helper()
		worker.Stop()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("Run() = %v, want nil", err)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("Run() didn't return after Stop()")
		}
	}
}

func runToError(t *testing.T, options ActorWorkerOptions) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- NewActorWorker(options, []ActorRegistration{doubleActor()}).Run() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Run() should fail")
		}
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("Run() didn't return")
		return nil
	}
}

func output(t *testing.T, r *sidecargatewayv1.InvokeResult) map[string]any {
	t.Helper()
	var v map[string]any
	if err := json.Unmarshal([]byte(r.GetOutputJson()), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// gate is a handler that blocks until released, recording how many run at
// once.
type gate struct {
	mu                     sync.Mutex
	running, peak, started int
	permits                chan struct{}
}

func newGate() *gate { return &gate{permits: make(chan struct{}, 64)} }

func (g *gate) handler(input any) (any, error) {
	g.mu.Lock()
	g.started++
	g.running++
	g.peak = max(g.peak, g.running)
	g.mu.Unlock()
	select {
	case <-g.permits:
	case <-time.After(10 * time.Second):
	}
	g.mu.Lock()
	g.running--
	g.mu.Unlock()
	return map[string]any{"done": input.(map[string]any)["n"]}, nil
}

func (g *gate) snapshot() (running, started, peak int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.running, g.started, g.peak
}

func (g *gate) release(n int) {
	for range n {
		g.permits <- struct{}{}
	}
}

// --- Tests --------------------------------------------------------------------------

func TestTLSAndBearerTokenRegisterAndServe(t *testing.T) {
	dir := makeTestTLS(t)
	token := filepath.Join(dir, "token")
	os.WriteFile(token, []byte("s3cret\n"), 0o600)
	g := startTCPGateway(t, serveOptions{tlsDir: dir, token: "s3cret"})
	o := tcpOptions(g.url)
	o.CAFile, o.TokenFile = filepath.Join(dir, "ca.crt"), token
	_, stop := startWorker(t, o, doubleActor())
	defer stop()
	waitFor(t, func() bool { return g.registerCount() == 1 })
	g.invoke(t, "inv-1", "double", 21)
	if got := output(t, g.result(t)); got["doubled"] != float64(42) {
		t.Fatalf("output %v", got)
	}
}

func TestAWrongTokenFailsFastWithUnauthenticated(t *testing.T) {
	dir := makeTestTLS(t)
	bad := filepath.Join(dir, "bad-token")
	os.WriteFile(bad, []byte("nope"), 0o600)
	g := startTCPGateway(t, serveOptions{tlsDir: dir, token: "s3cret"})
	o := tcpOptions(g.url)
	o.CAFile, o.TokenFile = filepath.Join(dir, "ca.crt"), bad
	err := runToError(t, o)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("Run() = %v, want Unauthenticated", err)
	}
	if n := len(g.seenAuthorizations()); n != 1 {
		t.Fatalf("%d sessions, want 1", n)
	}
}

func TestTheTokenFileIsReReadOnEveryReconnect(t *testing.T) {
	dir := makeTestTLS(t)
	token := filepath.Join(dir, "token")
	os.WriteFile(token, []byte("first"), 0o600)
	g := startTCPGateway(t, serveOptions{tlsDir: dir, maxConnectionAge: 300 * time.Millisecond})
	o := tcpOptions(g.url)
	o.CAFile, o.TokenFile = filepath.Join(dir, "ca.crt"), token
	_, stop := startWorker(t, o, doubleActor())
	waitFor(t, func() bool { return g.registerCount() == 1 })
	os.WriteFile(token, []byte("second"), 0o600)
	waitFor(t, func() bool { return g.registerCount() >= 2 })
	stop()
	seen := g.seenAuthorizations()
	if seen[0] != "Bearer first" || seen[len(seen)-1] != "Bearer second" {
		t.Fatalf("authorizations %v", seen)
	}
}

func TestMutualTLSWithAndWithoutAClientCertificate(t *testing.T) {
	dir := makeTestTLS(t)
	g := startTCPGateway(t, serveOptions{tlsDir: dir, mtls: true})
	o := tcpOptions(g.url)
	o.CAFile, o.CertFile, o.KeyFile = filepath.Join(dir, "ca.crt"), filepath.Join(dir, "client.crt"), filepath.Join(dir, "client.key")
	_, stop := startWorker(t, o, doubleActor())
	waitFor(t, func() bool { return g.registerCount() == 1 })
	g.invoke(t, "inv-1", "double", 2)
	if got := output(t, g.result(t)); got["doubled"] != float64(4) {
		t.Fatalf("output %v", got)
	}
	stop()

	noCert := tcpOptions(g.url)
	noCert.CAFile = filepath.Join(dir, "ca.crt")
	noCert.ReconnectMaxAttempts, noCert.ReconnectInitialDelayMs, noCert.ReconnectMaxDelayMs = 2, 10, 20
	if err := runToError(t, noCert); !strings.Contains(err.Error(), "giving up") {
		t.Fatalf("Run() = %v, want giving up", err)
	}
	if n := g.registerCount(); n != 1 {
		t.Fatalf("%d registrations, want 1", n)
	}
}

func TestAnUntrustedServerCertificateIsRefused(t *testing.T) {
	// No CAFile: the test CA isn't in the system roots.
	g := startTCPGateway(t, serveOptions{tlsDir: makeTestTLS(t)})
	o := tcpOptions(g.url)
	o.ReconnectMaxAttempts, o.ReconnectInitialDelayMs, o.ReconnectMaxDelayMs = 2, 10, 20
	if err := runToError(t, o); !strings.Contains(err.Error(), "giving up") {
		t.Fatalf("Run() = %v, want giving up", err)
	}
	if n := g.registerCount(); n != 0 {
		t.Fatalf("%d registrations, want 0", n)
	}
}

func TestPlaintextHTTPAddress(t *testing.T) {
	g := startTCPGateway(t, serveOptions{})
	_, stop := startWorker(t, tcpOptions(g.url), doubleActor())
	defer stop()
	waitFor(t, func() bool { return g.registerCount() == 1 })
	g.invoke(t, "inv-1", "double", 5)
	if got := output(t, g.result(t)); got["doubled"] != float64(10) {
		t.Fatalf("output %v", got)
	}
}

func TestInvokesRunConcurrentlyUpToMaxConcurrencyAndNeverBeyond(t *testing.T) {
	g := startTCPGateway(t, serveOptions{})
	slow := newGate()
	o := tcpOptions(g.url)
	o.MaxConcurrency = 2
	_, stop := startWorker(t, o, goActor("slow", slow.handler))
	defer stop()
	waitFor(t, func() bool { return g.registerCount() == 1 })
	if got := g.register(0).GetActors()[0].GetMaxConcurrency(); got != 2 {
		t.Fatalf("declared max_concurrency %d, want 2", got)
	}

	// Three invokes: two run at once, the third waits for a slot.
	for n := 1; n <= 3; n++ {
		g.invoke(t, fmt.Sprintf("inv-%d", n), "slow", n)
	}
	waitFor(t, func() bool { r, _, _ := slow.snapshot(); return r == 2 })
	time.Sleep(200 * time.Millisecond)
	if r, s, _ := slow.snapshot(); r != 2 || s != 2 {
		t.Fatalf("running %d started %d, want 2 and 2", r, s)
	}

	// Finishing one frees its slot: only then does the third start.
	slow.release(1)
	waitFor(t, func() bool { _, s, _ := slow.snapshot(); return s == 3 })
	slow.release(2)
	var ids []string
	for range 3 {
		ids = append(ids, g.result(t).GetInvokeId())
	}
	sort.Strings(ids)
	if strings.Join(ids, ",") != "inv-1,inv-2,inv-3" {
		t.Fatalf("results %v", ids)
	}
	if _, _, peak := slow.snapshot(); peak != 2 {
		t.Fatalf("peak %d, want 2", peak)
	}
}

func TestAnActorsOwnMaxConcurrencyOverridesTheWorkers(t *testing.T) {
	g := startTCPGateway(t, serveOptions{})
	capped := newGate()
	o := tcpOptions(g.url)
	o.MaxConcurrency = 5
	_, stop := startWorker(t, o, goActor("capped", capped.handler).WithMaxConcurrency(1), doubleActor())
	defer stop()
	waitFor(t, func() bool { return g.registerCount() == 1 })
	declared := map[string]uint32{}
	for _, a := range g.register(0).GetActors() {
		declared[a.GetAsyncOperationName()] = a.GetMaxConcurrency()
	}
	if declared["capped"] != 1 || declared["double"] != 5 {
		t.Fatalf("declared %v, want capped 1 and double 5", declared)
	}

	// The capped actor runs one at a time even with free worker slots.
	g.invoke(t, "inv-1", "capped", 1)
	g.invoke(t, "inv-2", "capped", 2)
	waitFor(t, func() bool { r, _, _ := capped.snapshot(); return r == 1 })
	time.Sleep(200 * time.Millisecond)
	if r, s, _ := capped.snapshot(); r != 1 || s != 1 {
		t.Fatalf("running %d started %d, want 1 and 1", r, s)
	}
	capped.release(1)
	waitFor(t, func() bool { _, s, _ := capped.snapshot(); return s == 2 })
	capped.release(1)
	g.result(t)
	g.result(t)
	if _, _, peak := capped.snapshot(); peak != 1 {
		t.Fatalf("peak %d, want 1", peak)
	}
}

func TestStopDrainsRefusingNewInvokesAsRetriable(t *testing.T) {
	g := startTCPGateway(t, serveOptions{})
	slow := newGate()
	o := tcpOptions(g.url)
	o.MaxConcurrency, o.ShutdownGraceMs = 2, 5000
	worker := NewActorWorker(o, []ActorRegistration{goActor("slow", slow.handler)})
	done := make(chan error, 1)
	go func() { done <- worker.Run() }()
	waitFor(t, func() bool { return g.registerCount() == 1 })
	g.invoke(t, "inv-1", "slow", 1)
	waitFor(t, func() bool { r, _, _ := slow.snapshot(); return r == 1 })

	worker.Stop() // doesn't block; Run returns after the drain
	// Arrives while draining: refused as retriable, not run.
	g.invoke(t, "inv-2", "slow", 2)
	e := g.next(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetInvokeError() != nil }).GetInvokeError()
	if e.GetInvokeId() != "inv-2" || e.GetError().GetCode() != "WORKER_DRAINING" || !e.GetError().GetRetriable() {
		t.Fatalf("invoke error %v", e)
	}
	if _, s, _ := slow.snapshot(); s != 1 {
		t.Fatalf("started %d, want 1", s)
	}
	select {
	case err := <-done:
		t.Fatalf("Run() returned %v before the drain", err)
	default:
	}

	// The in-flight invoke still completes and its result goes out, then the
	// worker unregisters and Run returns nil.
	slow.release(1)
	if id := g.result(t).GetInvokeId(); id != "inv-1" {
		t.Fatalf("result for %s, want inv-1", id)
	}
	g.next(t, func(r *sidecargatewayv1.SessionRequest) bool { return r.GetUnregister() != nil })
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() = %v", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Run() didn't return after the drain")
	}
}

func TestTheDrainGivesUpAfterShutdownGraceMs(t *testing.T) {
	g := startTCPGateway(t, serveOptions{})
	slow := newGate()
	o := tcpOptions(g.url)
	o.ShutdownGraceMs = 200
	_, stop := startWorker(t, o, goActor("slow", slow.handler))
	waitFor(t, func() bool { return g.registerCount() == 1 })
	g.invoke(t, "inv-1", "slow", 1)
	waitFor(t, func() bool { r, _, _ := slow.snapshot(); return r == 1 })
	started := time.Now()
	stop()
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("stop took %v", elapsed)
	}
	slow.release(1)
}

func TestReconnectsAfterTheServersMaxConnectionAge(t *testing.T) {
	g := startTCPGateway(t, serveOptions{maxConnectionAge: 300 * time.Millisecond})
	_, stop := startWorker(t, tcpOptions(g.url), doubleActor())
	defer stop()
	waitFor(t, func() bool { return g.registerCount() >= 2 })
	g.invoke(t, "inv-1", "double", 4)
	if got := output(t, g.result(t)); got["doubled"] != float64(8) {
		t.Fatalf("output %v", got)
	}
}

func TestAnInvalidGatewayAddressIsAnError(t *testing.T) {
	err := runToError(t, tcpOptions("tcp://gw:1"))
	if !strings.Contains(err.Error(), "gateway address") {
		t.Fatalf("Run() = %v", err)
	}
}

func TestParseGatewayAddress(t *testing.T) {
	cases := map[string]GatewayAddress{
		"unix:/tmp/x.sock":       {Kind: "unix", Path: "/tmp/x.sock"},
		"https://gw:7443":        {Kind: "tcp", URL: "https://gw:7443", TLS: true},
		"http://127.0.0.1:7443/": {Kind: "tcp", URL: "http://127.0.0.1:7443"},
		"https://[::1]:7443":     {Kind: "tcp", URL: "https://[::1]:7443", TLS: true},
	}
	for in, want := range cases {
		got, err := ParseGatewayAddress(in)
		if err != nil || got != want {
			t.Fatalf("%s: got %+v, %v; want %+v", in, got, err, want)
		}
	}
	if got, _ := ParseGatewayAddress("https://gw:7443"); got.target() != "gw:7443" {
		t.Fatalf("target %q", got.target())
	}
	for _, bad := range []string{"unix:", "tcp://gw:1", "https://gw", "gw:7443", "https://gw:x"} {
		if _, err := ParseGatewayAddress(bad); err == nil {
			t.Fatalf("%s should be rejected", bad)
		}
	}
}

func TestEffectiveMaxConcurrencyIsActorThenWorkerThen1(t *testing.T) {
	for _, c := range []struct{ actor, worker, want int }{{3, 10, 3}, {0, 10, 10}, {0, 0, 1}} {
		if got := EffectiveMaxConcurrency(c.actor, c.worker); got != c.want {
			t.Fatalf("EffectiveMaxConcurrency(%d, %d) = %d, want %d", c.actor, c.worker, got, c.want)
		}
	}
}
