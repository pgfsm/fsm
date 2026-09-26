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
	command           string
	gatewaySocketPath string
	workerID          string
	heartbeatMs       int
	help              bool
}

func helpText(invocation string) string {
	return fmt.Sprintf(`pgfsm async worker SDK — Go worker for the Activity Gateway

USAGE
  %[1]s <list|start> [options]

COMMANDS
  list    Print the actors compiled into this registry, without connecting to the gateway.
  start   Connect to the gateway and serve invocations for every actor in the registry until stopped.

OPTIONS
  -g, --gateway-socket <path>   Sidecar socket to connect to (default: %[2]s)
  -i, --worker-id <id>          Stable worker identity (default: go-<random>)
      --heartbeat-ms <ms>       Heartbeat interval (default: %[3]d)
  -h, --help                    Show this help message

Actors come from a compiler-generated registry (see fsm-compiler-ts's
writeAggregateGoRegistry), linked into the binary at compile time.

EXAMPLE
  %[1]s start --gateway-socket %[2]s
`, invocation, DefaultGatewaySocketPath, DefaultHeartbeatMs)
}

// parseArgs accepts the command and flags in any order, and both
// "--flag value" and "--flag=value".
func parseArgs(args []string) (parsedArgs, error) {
	parsed := parsedArgs{gatewaySocketPath: DefaultGatewaySocketPath, heartbeatMs: DefaultHeartbeatMs}
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
	return parsed, nil
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
// start stops the worker gracefully (unregistering from the gateway) on
// SIGINT/SIGTERM, and restores default signal handling once it returns.
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
		WorkerID:          workerID,
		GatewaySocketPath: parsed.gatewaySocketPath,
		HeartbeatMs:       parsed.heartbeatMs,
	}, registrations)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	defer func() {
		signal.Stop(signals)
		close(done)
	}()
	go func() {
		select {
		case <-signals:
			logger.Info("shutdown requested — stopping worker...")
			worker.Stop()
		case <-done:
		}
	}()

	logger.Info("starting worker", "worker_id", workerID, "gateway_socket", parsed.gatewaySocketPath)
	if err := worker.Run(); err != nil {
		logger.Error("worker failed", "worker_id", workerID, "error", err)
		return 1
	}
	logger.Info("worker stopped", "worker_id", workerID)
	return 0
}
