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
	// sources maps each set option's long name to the flag or variable its
	// value came from, for error messages.
	sources map[string]string
	help    bool
}

// EnvOptions are the options that fall back to an environment variable, by
// long name. Same list, names and precedence (flag -> variable -> default) in
// all four SDKs.
var EnvOptions = []string{
	"gateway-socket",
	"gateway-address",
	"gateway-ca-file",
	"gateway-token-file",
	"gateway-cert-file",
	"gateway-key-file",
	"max-concurrency",
	"keepalive-interval-ms",
	"keepalive-timeout-ms",
	"shutdown-grace-ms",
	"worker-id",
	"heartbeat-ms",
	"reconnect-initial-delay-ms",
	"reconnect-max-delay-ms",
	"reconnect-max-attempts",
}

// EnvVarFor is "PGFSM_" + the long option name upper-cased, "-" -> "_".
func EnvVarFor(option string) string {
	return "PGFSM_" + strings.ToUpper(strings.ReplaceAll(option, "-", "_"))
}

// canonical is the long option name for a flag ("-g", "--gateway-socket", ...).
func canonical(flag string) (string, bool) {
	switch flag {
	case "-g":
		return "gateway-socket", true
	case "-a":
		return "gateway-address", true
	case "-c":
		return "max-concurrency", true
	case "-i":
		return "worker-id", true
	}
	name, ok := strings.CutPrefix(flag, "--")
	if !ok {
		return "", false
	}
	for _, option := range EnvOptions {
		if option == name {
			return option, true
		}
	}
	return "", false
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

ENVIRONMENT
  Every option above except --help falls back to an environment variable when the flag
  isn't given: PGFSM_ + the long name in upper case, with - as _. A flag wins over its
  variable; an empty variable counts as unset. Credentials stay file paths.
    %[9]s

Actors come from a compiler-generated registry (see fsm-compiler-ts's
writeAggregateGoRegistry), linked into the binary at compile time.

EXAMPLES
  %[1]s start --gateway-socket %[2]s
  %[1]s start --gateway-address https://activity-gateway:7443 \\
    --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10
`, invocation, DefaultGatewaySocketPath, DefaultHeartbeatMs, DefaultReconnectInitialDelayMs, DefaultReconnectMaxDelayMs,
		DefaultKeepaliveIntervalMs, DefaultKeepaliveTimeoutMs, DefaultShutdownGraceMs, envVarList())
}

func envVarList() string {
	vars := make([]string, len(EnvOptions))
	for i, option := range EnvOptions {
		vars[i] = EnvVarFor(option)
	}
	return strings.Join(vars, "\n    ")
}

// parseArgs accepts the command and flags in any order, and both
// "--flag value" and "--flag=value". Every option not given as a flag falls
// back to its environment variable (read with getenv; an empty one counts as
// unset), then the default. An invalid value is reported by the flag or
// variable it came from.
func parseArgs(args []string, getenv func(string) string) (parsedArgs, error) {
	parsed := parsedArgs{
		heartbeatMs:       DefaultHeartbeatMs,
		reconnectInitial:  DefaultReconnectInitialDelayMs,
		reconnectMax:      DefaultReconnectMaxDelayMs,
		keepaliveInterval: DefaultKeepaliveIntervalMs,
		keepaliveTimeout:  DefaultKeepaliveTimeoutMs,
		shutdownGrace:     DefaultShutdownGraceMs,
		sources:           map[string]string{},
	}

	type setting struct{ value, label string }
	values := map[string]setting{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		flag, inline, hasInline := arg, "", false
		if strings.HasPrefix(arg, "--") {
			if name, value, ok := strings.Cut(arg, "="); ok {
				flag, inline, hasInline = name, value, true
			}
		}
		switch {
		case flag == "-h" || flag == "--help":
			parsed.help = true
		case (flag == "list" || flag == "start") && parsed.command == "":
			parsed.command = flag
		default:
			option, ok := canonical(flag)
			switch {
			case ok:
				label := "--" + option
				value := inline
				if !hasInline {
					if i+1 >= len(args) {
						return parsed, fmt.Errorf("%s requires a value", label)
					}
					i++
					value = args[i]
				}
				values[option] = setting{value, label}
			case strings.HasPrefix(flag, "-"):
				return parsed, fmt.Errorf("unknown option: %s", flag)
			default:
				return parsed, fmt.Errorf("first argument must be one of: list, start. Got: %s", flag)
			}
		}
	}

	// Where the gateway is counts as one setting: a flag for either form
	// overrides both variables.
	_, socketFlag := values["gateway-socket"]
	_, addressFlag := values["gateway-address"]
	locationFromFlags := socketFlag || addressFlag
	for _, option := range EnvOptions {
		if _, given := values[option]; given {
			continue
		}
		if locationFromFlags && (option == "gateway-socket" || option == "gateway-address") {
			continue
		}
		if v := getenv(EnvVarFor(option)); v != "" {
			values[option] = setting{v, EnvVarFor(option)}
		}
	}
	_, hasSocket := values["gateway-socket"]
	_, hasAddress := values["gateway-address"]
	if hasSocket && hasAddress {
		if locationFromFlags {
			return parsed, errors.New("pass either --gateway-socket or --gateway-address, not both")
		}
		return parsed, fmt.Errorf("set either %s or %s, not both", EnvVarFor("gateway-socket"), EnvVarFor("gateway-address"))
	}
	_, hasCert := values["gateway-cert-file"]
	_, hasKey := values["gateway-key-file"]
	if hasCert != hasKey {
		return parsed, fmt.Errorf("--gateway-cert-file and --gateway-key-file go together (or %s and %s)",
			EnvVarFor("gateway-cert-file"), EnvVarFor("gateway-key-file"))
	}

	integer := func(s setting, minimum int) (int, error) {
		n, err := strconv.Atoi(strings.TrimSpace(s.value))
		if err != nil || n < minimum {
			return 0, fmt.Errorf("%s must be an integer >= %d, got: %s", s.label, minimum, s.value)
		}
		return n, nil
	}
	ints := map[string]struct {
		min    int
		target *int
	}{
		"max-concurrency":            {1, &parsed.maxConcurrency},
		"keepalive-interval-ms":      {0, &parsed.keepaliveInterval},
		"keepalive-timeout-ms":       {1, &parsed.keepaliveTimeout},
		"shutdown-grace-ms":          {0, &parsed.shutdownGrace},
		"heartbeat-ms":               {1, &parsed.heartbeatMs},
		"reconnect-initial-delay-ms": {1, &parsed.reconnectInitial},
		"reconnect-max-delay-ms":     {1, &parsed.reconnectMax},
		"reconnect-max-attempts":     {0, &parsed.reconnectMaxAttempts},
	}
	strs := map[string]*string{
		"gateway-socket":     &parsed.gatewaySocketPath,
		"gateway-address":    &parsed.gatewayAddress,
		"gateway-ca-file":    &parsed.caFile,
		"gateway-token-file": &parsed.tokenFile,
		"gateway-cert-file":  &parsed.certFile,
		"gateway-key-file":   &parsed.keyFile,
		"worker-id":          &parsed.workerID,
	}
	// In EnvOptions order, so the first invalid value reported is stable.
	for _, option := range EnvOptions {
		s, ok := values[option]
		if !ok {
			continue
		}
		if spec, isInt := ints[option]; isInt {
			n, err := integer(s, spec.min)
			if err != nil {
				return parsed, err
			}
			*spec.target = n
		} else {
			if option == "gateway-address" {
				if _, err := ParseGatewayAddress(s.value); err != nil {
					return parsed, err
				}
			}
			*strs[option] = s.value
		}
		parsed.sources[option] = s.label
	}
	return parsed, nil
}

// checkReadable fails fast on unreadable credentials instead of retrying
// forever.
func checkReadable(parsed parsedArgs) error {
	for _, f := range []struct{ option, path string }{
		{"gateway-ca-file", parsed.caFile},
		{"gateway-token-file", parsed.tokenFile},
		{"gateway-cert-file", parsed.certFile},
		{"gateway-key-file", parsed.keyFile},
	} {
		if f.path == "" {
			continue
		}
		file, err := os.Open(f.path)
		if err != nil {
			label := parsed.sources[f.option]
			if label == "" {
				label = "--" + f.option
			}
			return fmt.Errorf("can't read %s file %s", label, f.path)
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
// Every option falls back to its environment variable (see [EnvVarFor]) when
// the flag isn't given.
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

	parsed, err := parseArgs(args, os.Getenv)
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
