package asyncworkersdk

// RunActorWorkerCLI's argument parsing and exit codes — the same cases as the
// Python SDK's test_cli.py and the Rust crate's tests/cli.rs. None of these
// reach a gateway.

import (
	"io"
	"os"
	"strings"
	"testing"
)

func run(args ...string) int {
	return runCLI(testRegistrations(), args, "", io.Discard)
}

func TestHelpExits0(t *testing.T) {
	var out strings.Builder
	if code := runCLI(testRegistrations(), []string{"--help"}, "my-worker", &out); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if !strings.Contains(out.String(), "my-worker <list|start>") {
		t.Fatalf("help doesn't use the invocation:\n%s", out.String())
	}
}

func TestListExits0WithoutConnecting(t *testing.T) {
	if code := run("list", "--gateway-socket", "/nonexistent.sock"); code != 0 {
		t.Fatalf("exit code %d", code)
	}
}

func TestMissingOrUnknownCommandExits1(t *testing.T) {
	for _, args := range [][]string{{}, {"serve"}, {"list", "start"}, {"start", "--bogus"}, {"start", "--gateway-socket"}, {"start", "--heartbeat-ms", "0"}} {
		if code := run(args...); code != 1 {
			t.Fatalf("%v: exit code %d, want 1", args, code)
		}
	}
}

func TestStartWithEmptyRegistryExits1(t *testing.T) {
	if code := runCLI(nil, []string{"start"}, "", io.Discard); code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

// Without --reconnect-max-attempts the worker would wait for the gateway
// forever (#392).
func TestStartAgainstMissingSocketExits1AfterMaxReconnectAttempts(t *testing.T) {
	if code := run("start", "--gateway-socket", "/nonexistent/gw.sock", "--reconnect-initial-delay-ms=5", "--reconnect-max-attempts=2"); code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

func TestParseArgs(t *testing.T) {
	p, err := parseArgs([]string{"-g", "/tmp/x.sock", "start", "--worker-id=w1", "--heartbeat-ms", "250"})
	if err != nil {
		t.Fatal(err)
	}
	if p.command != "start" || p.gatewaySocketPath != "/tmp/x.sock" || p.workerID != "w1" || p.heartbeatMs != 250 {
		t.Fatalf("unexpected parse: %+v", p)
	}
	p, _ = parseArgs([]string{"list"})
	if p.gatewaySocketPath != "" || p.gatewayAddress != "" || p.heartbeatMs != DefaultHeartbeatMs || p.workerID != "" {
		t.Fatalf("unexpected defaults: %+v", p)
	}
	if p.reconnectInitial != DefaultReconnectInitialDelayMs || p.reconnectMax != DefaultReconnectMaxDelayMs || p.reconnectMaxAttempts != 0 {
		t.Fatalf("unexpected reconnect defaults: %+v", p)
	}
	p, err = parseArgs([]string{"start", "--reconnect-initial-delay-ms=5", "--reconnect-max-delay-ms", "100", "--reconnect-max-attempts", "3"})
	if err != nil || p.reconnectInitial != 5 || p.reconnectMax != 100 || p.reconnectMaxAttempts != 3 {
		t.Fatalf("unexpected reconnect parse: %+v, %v", p, err)
	}
	if _, err := parseArgs([]string{"start", "--reconnect-max-attempts", "-1"}); err == nil {
		t.Fatal("negative --reconnect-max-attempts should be rejected")
	}
	if id := randomWorkerID(); !strings.HasPrefix(id, "go-") || len(id) != 11 {
		t.Fatalf("unexpected worker id %q", id)
	}
}

func TestParseArgsTCPConcurrencyAndDrain(t *testing.T) {
	p, err := parseArgs([]string{"start", "-a", "https://gw:7443", "--gateway-ca-file=ca.crt", "--gateway-token-file", "token",
		"--gateway-cert-file", "c.crt", "--gateway-key-file", "c.key", "-c", "10",
		"--keepalive-interval-ms", "0", "--keepalive-timeout-ms", "500", "--shutdown-grace-ms", "0"})
	if err != nil {
		t.Fatal(err)
	}
	want := parsedArgs{command: "start", gatewayAddress: "https://gw:7443", caFile: "ca.crt", tokenFile: "token",
		certFile: "c.crt", keyFile: "c.key", maxConcurrency: 10, keepaliveInterval: 0, keepaliveTimeout: 500, shutdownGrace: 0,
		heartbeatMs: DefaultHeartbeatMs, reconnectInitial: DefaultReconnectInitialDelayMs, reconnectMax: DefaultReconnectMaxDelayMs}
	if p != want {
		t.Fatalf("got %+v\nwant %+v", p, want)
	}
	p, _ = parseArgs([]string{"list"})
	if p.maxConcurrency != 0 || p.keepaliveInterval != DefaultKeepaliveIntervalMs || p.keepaliveTimeout != DefaultKeepaliveTimeoutMs || p.shutdownGrace != DefaultShutdownGraceMs {
		t.Fatalf("unexpected defaults: %+v", p)
	}
}

// Flag validation (SPEC-007): bad flags exit 1 before connecting, instead of
// retrying forever against a misconfiguration.
func TestBadTCPConcurrencyAndDrainFlagsExit1(t *testing.T) {
	for _, args := range [][]string{
		{"start", "-g", "/tmp/x.sock", "-a", "unix:/tmp/y.sock"},
		{"start", "-a", "tcp://gw:1"},
		{"start", "-a", "https://gw"},
		{"start", "-a", "unix:"},
		{"start", "--gateway-cert-file", "c.crt"},
		{"start", "--gateway-key-file", "c.key"},
		{"start", "-c", "0"},
		{"start", "-c", "-1"},
		{"start", "-c", ""},
		{"start", "--keepalive-interval-ms", "-1"},
		{"start", "--keepalive-timeout-ms", "0"},
		{"start", "--shutdown-grace-ms", ""},
		{"start", "-a", "https://gw:7443", "--gateway-ca-file", "/nonexistent/file"},
		{"start", "-a", "https://gw:7443", "--gateway-token-file", "/nonexistent/file"},
	} {
		if code := run(args...); code != 1 {
			t.Fatalf("%v: exit code %d, want 1", args, code)
		}
	}
}

func TestListAcceptsTheTCPFlags(t *testing.T) {
	token := t.TempDir() + "/token"
	if err := os.WriteFile(token, []byte("t"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := run("list", "-a", "https://gw:7443", "--gateway-token-file", token, "-c", "4", "--keepalive-interval-ms", "0"); code != 0 {
		t.Fatalf("exit code %d", code)
	}
}
