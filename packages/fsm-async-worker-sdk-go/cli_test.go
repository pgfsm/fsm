package asyncworkersdk

// RunActorWorkerCLI's argument parsing and exit codes — the same cases as the
// Python SDK's test_cli.py and the Rust crate's tests/cli.rs. None of these
// reach a gateway.

import (
	"io"
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

func TestStartAgainstMissingSocketExits1(t *testing.T) {
	if code := run("start", "--gateway-socket", "/nonexistent/gw.sock"); code != 1 {
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
	if p.gatewaySocketPath != DefaultGatewaySocketPath || p.heartbeatMs != DefaultHeartbeatMs || p.workerID != "" {
		t.Fatalf("unexpected defaults: %+v", p)
	}
	if id := randomWorkerID(); !strings.HasPrefix(id, "go-") || len(id) != 11 {
		t.Fatalf("unexpected worker id %q", id)
	}
}
