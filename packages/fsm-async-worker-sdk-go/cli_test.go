package asyncworkersdk

// RunActorWorkerCLI's argument parsing and exit codes — the same cases as the
// Python SDK's test_cli.py and the Rust crate's tests/cli.rs. None of these
// reach a gateway.

import (
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
)

// noEnv is an environment with nothing set, so a stray PGFSM_* variable
// can't change what these tests parse.
func noEnv(string) string { return "" }

// envOf is an environment with only vars set.
func envOf(vars map[string]string) func(string) string {
	return func(name string) string { return vars[name] }
}

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
	p, err := parseArgs([]string{"-g", "/tmp/x.sock", "start", "--worker-id=w1", "--heartbeat-ms", "250"}, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	if p.command != "start" || p.gatewaySocketPath != "/tmp/x.sock" || p.workerID != "w1" || p.heartbeatMs != 250 {
		t.Fatalf("unexpected parse: %+v", p)
	}
	p, _ = parseArgs([]string{"list"}, noEnv)
	if p.gatewaySocketPath != "" || p.gatewayAddress != "" || p.heartbeatMs != DefaultHeartbeatMs || p.workerID != "" {
		t.Fatalf("unexpected defaults: %+v", p)
	}
	if p.reconnectInitial != DefaultReconnectInitialDelayMs || p.reconnectMax != DefaultReconnectMaxDelayMs || p.reconnectMaxAttempts != 0 {
		t.Fatalf("unexpected reconnect defaults: %+v", p)
	}
	p, err = parseArgs([]string{"start", "--reconnect-initial-delay-ms=5", "--reconnect-max-delay-ms", "100", "--reconnect-max-attempts", "3"}, noEnv)
	if err != nil || p.reconnectInitial != 5 || p.reconnectMax != 100 || p.reconnectMaxAttempts != 3 {
		t.Fatalf("unexpected reconnect parse: %+v, %v", p, err)
	}
	if _, err := parseArgs([]string{"start", "--reconnect-max-attempts", "-1"}, noEnv); err == nil {
		t.Fatal("negative --reconnect-max-attempts should be rejected")
	}
	if id := randomWorkerID(); !strings.HasPrefix(id, "go-") || len(id) != 11 {
		t.Fatalf("unexpected worker id %q", id)
	}
}

func TestParseArgsTCPConcurrencyAndDrain(t *testing.T) {
	p, err := parseArgs([]string{"start", "-a", "https://gw:7443", "--gateway-ca-file=ca.crt", "--gateway-token-file", "token",
		"--gateway-cert-file", "c.crt", "--gateway-key-file", "c.key", "-c", "10",
		"--keepalive-interval-ms", "0", "--keepalive-timeout-ms", "500", "--shutdown-grace-ms", "0"}, noEnv)
	if err != nil {
		t.Fatal(err)
	}
	want := parsedArgs{command: "start", gatewayAddress: "https://gw:7443", caFile: "ca.crt", tokenFile: "token",
		certFile: "c.crt", keyFile: "c.key", maxConcurrency: 10, keepaliveInterval: 0, keepaliveTimeout: 500, shutdownGrace: 0,
		heartbeatMs: DefaultHeartbeatMs, reconnectInitial: DefaultReconnectInitialDelayMs, reconnectMax: DefaultReconnectMaxDelayMs}
	want.sources = p.sources
	if !reflect.DeepEqual(p, want) {
		t.Fatalf("got %+v\nwant %+v", p, want)
	}
	p, _ = parseArgs([]string{"list"}, noEnv)
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

// Environment-variable fallbacks (#438): every option falls back to
// PGFSM_<LONG_NAME>; a flag wins over its variable; an empty variable counts
// as unset; invalid values are named by their variable.

func TestEnvVarNamesMatchTheOtherSDKs(t *testing.T) {
	want := []string{
		"PGFSM_GATEWAY_SOCKET", "PGFSM_GATEWAY_ADDRESS", "PGFSM_GATEWAY_CA_FILE",
		"PGFSM_GATEWAY_TOKEN_FILE", "PGFSM_GATEWAY_CERT_FILE", "PGFSM_GATEWAY_KEY_FILE",
		"PGFSM_MAX_CONCURRENCY", "PGFSM_KEEPALIVE_INTERVAL_MS", "PGFSM_KEEPALIVE_TIMEOUT_MS",
		"PGFSM_SHUTDOWN_GRACE_MS", "PGFSM_WORKER_ID", "PGFSM_HEARTBEAT_MS",
		"PGFSM_RECONNECT_INITIAL_DELAY_MS", "PGFSM_RECONNECT_MAX_DELAY_MS", "PGFSM_RECONNECT_MAX_ATTEMPTS",
	}
	var got []string
	for _, o := range EnvOptions {
		got = append(got, EnvVarFor(o))
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestEveryOptionComesFromItsVariable(t *testing.T) {
	p, err := parseArgs([]string{"start"}, envOf(map[string]string{
		"PGFSM_GATEWAY_ADDRESS":            "https://gw:7443",
		"PGFSM_GATEWAY_CA_FILE":            "ca.crt",
		"PGFSM_GATEWAY_TOKEN_FILE":         "token",
		"PGFSM_GATEWAY_CERT_FILE":          "c.crt",
		"PGFSM_GATEWAY_KEY_FILE":           "c.key",
		"PGFSM_MAX_CONCURRENCY":            "10",
		"PGFSM_KEEPALIVE_INTERVAL_MS":      "0",
		"PGFSM_KEEPALIVE_TIMEOUT_MS":       "500",
		"PGFSM_SHUTDOWN_GRACE_MS":          "1000",
		"PGFSM_WORKER_ID":                  "w-env",
		"PGFSM_HEARTBEAT_MS":               "250",
		"PGFSM_RECONNECT_INITIAL_DELAY_MS": "5",
		"PGFSM_RECONNECT_MAX_DELAY_MS":     "100",
		"PGFSM_RECONNECT_MAX_ATTEMPTS":     "3",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := parsedArgs{command: "start", gatewayAddress: "https://gw:7443", caFile: "ca.crt", tokenFile: "token",
		certFile: "c.crt", keyFile: "c.key", maxConcurrency: 10, keepaliveInterval: 0, keepaliveTimeout: 500,
		shutdownGrace: 1000, workerID: "w-env", heartbeatMs: 250, reconnectInitial: 5, reconnectMax: 100,
		reconnectMaxAttempts: 3}
	if p.sources["max-concurrency"] != "PGFSM_MAX_CONCURRENCY" {
		t.Fatalf("sources %v", p.sources)
	}
	want.sources = p.sources
	if !reflect.DeepEqual(p, want) {
		t.Fatalf("got %+v\nwant %+v", p, want)
	}
}

func TestAFlagWinsAndAnEmptyVariableIsUnset(t *testing.T) {
	p, err := parseArgs([]string{"start", "-c", "2", "--worker-id", "w-flag"}, envOf(map[string]string{
		"PGFSM_MAX_CONCURRENCY":   "10",
		"PGFSM_WORKER_ID":         "w-env",
		"PGFSM_SHUTDOWN_GRACE_MS": "",
		"PGFSM_GATEWAY_SOCKET":    "/tmp/env.sock",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if p.maxConcurrency != 2 || p.workerID != "w-flag" || p.shutdownGrace != DefaultShutdownGraceMs || p.gatewaySocketPath != "/tmp/env.sock" {
		t.Fatalf("unexpected parse: %+v", p)
	}
	// A valid flag overrides an invalid variable, which isn't read.
	if _, err := parseArgs([]string{"start", "-c", "3"}, envOf(map[string]string{"PGFSM_MAX_CONCURRENCY": "zero"})); err != nil {
		t.Fatal(err)
	}
}

func TestAGatewayFlagOfEitherFormOverridesBothVariables(t *testing.T) {
	p, err := parseArgs([]string{"start", "-g", "/tmp/x.sock"}, envOf(map[string]string{"PGFSM_GATEWAY_ADDRESS": "https://gw:7443"}))
	if err != nil || p.gatewaySocketPath != "/tmp/x.sock" || p.gatewayAddress != "" {
		t.Fatalf("got %+v, %v", p, err)
	}
	_, err = parseArgs([]string{"start"}, envOf(map[string]string{
		"PGFSM_GATEWAY_SOCKET":  "/tmp/x.sock",
		"PGFSM_GATEWAY_ADDRESS": "https://gw:7443",
	}))
	if err == nil || !strings.Contains(err.Error(), "PGFSM_GATEWAY_SOCKET") {
		t.Fatalf("got %v", err)
	}
}

func TestInvalidVariablesAreReportedByName(t *testing.T) {
	for _, c := range []struct{ name, value, named string }{
		{"PGFSM_MAX_CONCURRENCY", "0", "PGFSM_MAX_CONCURRENCY"},
		{"PGFSM_MAX_CONCURRENCY", "two", "PGFSM_MAX_CONCURRENCY"},
		{"PGFSM_KEEPALIVE_TIMEOUT_MS", "0", "PGFSM_KEEPALIVE_TIMEOUT_MS"},
		{"PGFSM_SHUTDOWN_GRACE_MS", "-1", "PGFSM_SHUTDOWN_GRACE_MS"},
		{"PGFSM_HEARTBEAT_MS", "0", "PGFSM_HEARTBEAT_MS"},
		{"PGFSM_RECONNECT_MAX_ATTEMPTS", "x", "PGFSM_RECONNECT_MAX_ATTEMPTS"},
		{"PGFSM_GATEWAY_ADDRESS", "tcp://gw:1", "tcp://gw:1"},
		{"PGFSM_GATEWAY_CERT_FILE", "/tmp/c", "PGFSM_GATEWAY_KEY_FILE"},
	} {
		_, err := parseArgs([]string{"start"}, envOf(map[string]string{c.name: c.value}))
		if err == nil || !strings.Contains(err.Error(), c.named) {
			t.Fatalf("%s=%s: got %v", c.name, c.value, err)
		}
	}
	p, err := parseArgs([]string{"start"}, envOf(map[string]string{"PGFSM_GATEWAY_TOKEN_FILE": "/nonexistent/t"}))
	if err != nil {
		t.Fatal(err)
	}
	if err := checkReadable(p); err == nil || !strings.Contains(err.Error(), "PGFSM_GATEWAY_TOKEN_FILE") {
		t.Fatalf("got %v", err)
	}
}

func TestStartExits1OnAnInvalidVariableAndAFlagOverridesIt(t *testing.T) {
	t.Setenv("PGFSM_MAX_CONCURRENCY", "zero")
	if code := run("start"); code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	if code := run("list", "--max-concurrency", "3"); code != 0 {
		t.Fatalf("exit code %d, want 0", code)
	}
}

func TestHelpListsEveryVariable(t *testing.T) {
	help := helpText("x")
	for _, o := range EnvOptions {
		if !strings.Contains(help, EnvVarFor(o)) {
			t.Fatalf("help doesn't mention %s", EnvVarFor(o))
		}
	}
}
