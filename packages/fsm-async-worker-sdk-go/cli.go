package asyncworkersdk

// The list/start command handling for a compiler-generated worker main.go —
// replaces the flag parsing and startup that fsm-compiler-ts's
// go/worker-sdk-main.eta used to write into every project (#370).
//
// Go counterpart of @pgfsm/async-worker-sdk's runActorWorkerCli,
// pgfsm-async-worker-sdk's run_actor_worker_cli (Python) and the Rust
// crate's run_actor_worker_cli: same commands, flags and exit codes. Logging
// goes through log/slog's default logger, which the caller may configure.

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
)

// DefaultGatewaySocketPath is the sidecar socket the worker connects to unless
// --gateway-socket is given.
const DefaultGatewaySocketPath = "/tmp/pgfsm-activity-gateway-workers.sock"

const defaultInvocation = "go run ."

type parsedArgs struct {
	command              string
	gatewaySocketPath    string
	gatewayAddress       string
	caFile               string
	tokenFile            string
	certFile             string
	keyFile              string
	maxConcurrency       int
	keepaliveInterval    int
	keepaliveTimeout     int
	shutdownGrace        int
	workerID             string
	heartbeatMs          int
	reconnectInitial     int
	reconnectMax         int
	reconnectMaxAttempts int
	help                 bool
}

func helpText(invocation string) string {
	return fmt.Sprintf(`pgfsm async worker SDK — Go worker for the Activity Gateway

USAGE
  %[1]s <list|start> [options]

COMMANDS
  list    Print the actors compiled into this registry, without connecting to the gateway.
  start   Connect to the gateway and serve invocations for every actor in the registry until stopped.
          Waits for the gateway if it isn't up yet, and reconnects and re-registers if the
          session drops (e.g. the gateway restarts). On SIGINT/SIGTERM it drains: new invokes
          are refused as retriable while in-flight ones finish.

OPTIONS
  -g, --gateway-socket <path>   Sidecar socket to connect to (default: %[2]s)
  -a, --gateway-address <addr>  Gateway sidecar address instead: unix:<path>, https://host:port,
                                or http://host:port (the gateway's --insecure-plaintext test mode)
      --gateway-ca-file <file>  PEM CA bundle to trust the gateway's TLS certificate (default: system roots)
      --gateway-token-file <file>
                                Bearer token sent to the gateway; re-read on every reconnect
      --gateway-cert-file <file>
      --gateway-key-file <file> Client certificate and key for mutual TLS
  -c, --max-concurrency <n>     Invokes of each actor run at once, for actors without their own
                                MaxConcurrency (default: 1). Handlers must be concurrency-safe above 1.
      --keepalive-interval-ms <ms>
                                HTTP/2 PING interval over TCP (default: %[6]d; 0 disables; min 10000)
      --keepalive-timeout-ms <ms>
                                Reconnect when a PING goes unanswered this long (default: %[7]d)
      --shutdown-grace-ms <ms>  On SIGINT/SIGTERM, let in-flight invokes finish this long (default: %[8]d)
  -i, --worker-id <id>          Stable worker identity (default: go-<random>)
      --heartbeat-ms <ms>       Heartbeat interval (default: %[3]d)
      --reconnect-initial-delay-ms <ms>
                                First reconnect backoff step (default: %[4]d)
      --reconnect-max-delay-ms <ms>
                                Reconnect backoff cap (default: %[5]d)
      --reconnect-max-attempts <n>
                                Exit after n consecutive failed attempts (default: 0 = retry forever)
  -h, --help                    Show this help message

Actors come from a compiler-generated registry (see fsm-compiler-ts's
writeAggregateGoRegistry), linked into the binary at compile time.

EXAMPLES
  %[1]s start --gateway-socket %[2]s
  %[1]s start --gateway-address https://activity-gateway:7443 \\
    --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10
`, invocation, DefaultGatewaySocketPath, DefaultHeartbeatMs, DefaultReconnectInitialDelayMs, DefaultReconnectMaxDelayMs,
		DefaultKeepaliveIntervalMs, DefaultKeepaliveTimeoutMs, DefaultShutdownGraceMs)
}

// parseArgs accepts the command and flags in any order, and both
// "--flag value" and "--flag=value".
func parseArgs(args []string) (parsedArgs, error) {
	parsed := parsedArgs{
		heartbeatMs:       DefaultHeartbeatMs,
		reconnectInitial:  DefaultReconnectInitialDelayMs,
		reconnectMax:      DefaultReconnectMaxDelayMs,
		keepaliveInterval: DefaultKeepaliveIntervalMs,
		keepaliveTimeout:  DefaultKeepaliveTimeoutMs,
		shutdownGrace:     DefaultShutdownGraceMs,
	}
	// intFlag reads an integer flag >= minimum.
	intFlag := func(flag, v string, minimum int) (int, error) {
		n, err := strconv.Atoi(v)
		if err != nil || n < minimum {
			return 0, fmt.Errorf("%s must be an integer >= %d, got: %s", flag, minimum, v)
		}
		return n, nil
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		flag, inline, hasInline := arg, "", false
		if strings.HasPrefix(arg, "--") {
			if name, value, ok := strings.Cut(arg, "="); ok {
				flag, inline, hasInline = name, value, true
			}
		}
		value := func(name string) (string, error) {
			if hasInline {
				return inline, nil
			}
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s requires a value", name)
			}
			i++
			return args[i], nil
		}

		switch flag {
		case "-h", "--help":
			parsed.help = true
		case "-g", "--gateway-socket":
			v, err := value("--gateway-socket")
			if err != nil {
				return parsed, err
			}
			parsed.gatewaySocketPath = v
		case "-a", "--gateway-address":
			v, err := value("--gateway-address")
			if err != nil {
				return parsed, err
			}
			if _, err := ParseGatewayAddress(v); err != nil {
				return parsed, err
			}
			parsed.gatewayAddress = v
		case "--gateway-ca-file", "--gateway-token-file", "--gateway-cert-file", "--gateway-key-file":
			v, err := value(flag)
			if err != nil {
				return parsed, err
			}
			switch flag {
			case "--gateway-ca-file":
				parsed.caFile = v
			case "--gateway-token-file":
				parsed.tokenFile = v
			case "--gateway-cert-file":
				parsed.certFile = v
			default:
				parsed.keyFile = v
			}
		case "-c", "--max-concurrency", "--keepalive-interval-ms", "--keepalive-timeout-ms", "--shutdown-grace-ms":
			name := flag
			if name == "-c" {
				name = "--max-concurrency"
			}
			v, err := value(name)
			if err != nil {
				return parsed, err
			}
			minimum := map[string]int{"--max-concurrency": 1, "--keepalive-interval-ms": 0, "--keepalive-timeout-ms": 1, "--shutdown-grace-ms": 0}[name]
			n, err := intFlag(name, v, minimum)
			if err != nil {
				return parsed, err
			}
			switch name {
			case "--max-concurrency":
				parsed.maxConcurrency = n
			case "--keepalive-interval-ms":
				parsed.keepaliveInterval = n
			case "--keepalive-timeout-ms":
				parsed.keepaliveTimeout = n
			default:
				parsed.shutdownGrace = n
			}
		case "-i", "--worker-id":
			v, err := value("--worker-id")
			if err != nil {
				return parsed, err
			}
			parsed.workerID = v
		case "--heartbeat-ms":
			v, err := value("--heartbeat-ms")
			if err != nil {
				return parsed, err
			}
			ms, convErr := strconv.Atoi(v)
			if convErr != nil || ms <= 0 {
				return parsed, fmt.Errorf("--heartbeat-ms must be a positive integer, got: %s", v)
			}
			parsed.heartbeatMs = ms
		case "--reconnect-initial-delay-ms", "--reconnect-max-delay-ms", "--reconnect-max-attempts":
			v, err := value(flag)
			if err != nil {
				return parsed, err
			}
			n, convErr := strconv.Atoi(v)
			minimum := 1
			if flag == "--reconnect-max-attempts" {
				minimum = 0
			}
			if convErr != nil || n < minimum {
				return parsed, fmt.Errorf("%s must be an integer >= %d, got: %s", flag, minimum, v)
			}
			switch flag {
			case "--reconnect-initial-delay-ms":
				parsed.reconnectInitial = n
			case "--reconnect-max-delay-ms":
				parsed.reconnectMax = n
			default:
				parsed.reconnectMaxAttempts = n
			}
		default:
			switch {
			case strings.HasPrefix(flag, "-"):
				return parsed, fmt.Errorf("unknown option: %s", flag)
			case (flag == "list" || flag == "start") && parsed.command == "":
				parsed.command = flag
			default:
				return parsed, fmt.Errorf("first argument must be one of: list, start. Got: %s", flag)
			}
		}
	}
	if parsed.gatewaySocketPath != "" && parsed.gatewayAddress != "" {
		return parsed, errors.New("pass either --gateway-socket or --gateway-address, not both")
	}
	if (parsed.certFile == "") != (parsed.keyFile == "") {
		return parsed, errors.New("--gateway-cert-file and --gateway-key-file go together")
	}
	return parsed, nil
}

// checkReadable fails fast on unreadable credentials instead of retrying
// forever.
func checkReadable(parsed parsedArgs) error {
	for _, f := range []struct{ flag, path string }{
		{"--gateway-ca-file", parsed.caFile},
		{"--gateway-token-file", parsed.tokenFile},
		{"--gateway-cert-file", parsed.certFile},
		{"--gateway-key-file", parsed.keyFile},
	} {
		if f.path == "" {
			continue
		}
		file, err := os.Open(f.path)
		if err != nil {
			return fmt.Errorf("can't read %s file %s", f.flag, f.path)
		}
		file.Close()
	}
	return nil
}

// optionMs maps a CLI value where 0 means "none" onto an option where 0
// means "default" and a negative value means "none".
func optionMs(v int) int {
	if v == 0 {
		return -1
	}
	return v
}

func randomWorkerID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("go-%d", os.Getpid())
	}
	return "go-" + hex.EncodeToString(b)
}

// RunActorWorkerCLI runs the list/start worker CLI against registrations and
// returns the process exit code — the caller decides whether to exit with
// it, which keeps this testable. args excludes the program name
// (os.Args[1:]).
//
// start stops the worker gracefully on SIGINT/SIGTERM (draining in-flight
// invokes, then unregistering from the gateway), and restores default signal
// handling once it returns.
//
// invocation is how to run the calling program, shown in --help; "" means
// "go run .".
func RunActorWorkerCLI(registrations []ActorRegistration, args []string, invocation string) int {
	return runCLI(registrations, args, invocation, os.Stdout)
}

func runCLI(registrations []ActorRegistration, args []string, invocation string, stdout io.Writer) int {
	if invocation == "" {
		invocation = defaultInvocation
	}
	logger := slog.Default().With("component", "pgfsm.async_worker_sdk.cli")

	parsed, err := parseArgs(args)
	if err != nil {
		logger.Error(err.Error())
		fmt.Fprint(stdout, helpText(invocation))
		return 1
	}
	if parsed.help {
		fmt.Fprint(stdout, helpText(invocation))
		return 0
	}
	if parsed.command == "" {
		logger.Error("first argument must be one of: list, start. Got: (none)")
		fmt.Fprint(stdout, helpText(invocation))
		return 1
	}

	if err := checkReadable(parsed); err != nil {
		logger.Error(err.Error())
		return 1
	}
	gatewayAddress := parsed.gatewayAddress
	if gatewayAddress == "" {
		socket := parsed.gatewaySocketPath
		if socket == "" {
			socket = DefaultGatewaySocketPath
		}
		gatewayAddress = "unix:" + socket
	}

	workerID := parsed.workerID
	if workerID == "" {
		workerID = randomWorkerID()
	}

	logger.Info(fmt.Sprintf("%d actor(s) compiled into this registry", len(registrations)))
	for _, reg := range registrations {
		m := reg.Meta
		logger.Info(fmt.Sprintf("  + %s@%s (parent %s@%s)", m.GetAsyncOperationName(), m.GetAsyncOperationVersion(), m.GetParentFsmName(), m.GetParentFsmVersion()))
	}

	if parsed.command == "list" {
		return 0
	}
	if len(registrations) == 0 {
		logger.Error("no actors in the registry, refusing to start worker")
		return 1
	}

	worker := NewActorWorker(ActorWorkerOptions{
		WorkerID:            workerID,
		GatewayAddress:      gatewayAddress,
		CAFile:              parsed.caFile,
		TokenFile:           parsed.tokenFile,
		CertFile:            parsed.certFile,
		KeyFile:             parsed.keyFile,
		MaxConcurrency:      parsed.maxConcurrency,
		KeepaliveIntervalMs: optionMs(parsed.keepaliveInterval),
		KeepaliveTimeoutMs:  parsed.keepaliveTimeout,
		ShutdownGraceMs:     optionMs(parsed.shutdownGrace),
		HeartbeatMs:         parsed.heartbeatMs,

		ReconnectInitialDelayMs: parsed.reconnectInitial,
		ReconnectMaxDelayMs:     parsed.reconnectMax,
		ReconnectMaxAttempts:    parsed.reconnectMaxAttempts,
	}, registrations)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	defer func() {
		signal.Stop(signals)
		close(done)
	}()
	go func() {
		stopping := false
		for {
			select {
			case <-signals:
				if stopping {
					logger.Info("already stopping: waiting for in-flight invokes to finish")
					continue
				}
				stopping = true
				logger.Info("shutdown requested — draining and stopping worker...")
				worker.Stop()
			case <-done:
				return
			}
		}
	}()

	logger.Info("starting worker", "worker_id", workerID, "gateway", gatewayAddress)
	if err := worker.Run(); err != nil {
		logger.Error("worker failed", "worker_id", workerID, "error", err)
		return 1
	}
	logger.Info("worker stopped", "worker_id", workerID)
	return 0
}
