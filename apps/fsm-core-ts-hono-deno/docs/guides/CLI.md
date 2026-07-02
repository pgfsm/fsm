# fsm-server CLI

Start the FSM Hono server with configurable database URL, URL prefix, and FSM
folder paths.

## Prerequisites

The server requires these environment variables (via `.env` file or shell):

| Variable                    | Required                         | Description                                                                  |
| --------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL`              | Yes*                             | PostgreSQL connection string — can be supplied via `--db-url` instead        |
| `DB_TYPE`                   | No                               | `postgres` (default), `supabase`, or `supabase_and_postgres`                 |
| `CORS_ORIGIN`               | No                               | Allowed CORS origin (default: `http://localhost:5173`)                       |
| `LOG_LEVEL`                 | No                               | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `PORT`                      | No                               | Port to listen on (default: `9999`) — can be supplied via `--port` instead   |
| `SUPABASE_URL`              | If `DB_TYPE` includes `supabase` | Supabase project URL                                                         |
| `SUPABASE_SERVICE_ROLE_KEY` | If `DB_TYPE` includes `supabase` | Supabase service role key                                                    |
| `SUPABASE_ANON_KEY`         | If `DB_TYPE` includes `supabase` | Supabase anon key                                                            |

## Usage

```
deno run --allow-all src/cli/index.ts [options]
```

## Options

| Flag                           | Short | Default         | Description                                 |
| ------------------------------ | ----- | --------------- | ------------------------------------------- |
| `--db-url <url>`               | `-d`  | `$DATABASE_URL` | PostgreSQL connection string                |
| `--url-path-prefix <prefix>`   | `-u`  | `/fsm`          | URL path prefix for all routes              |
| `--port <n>`                   | `-p`  | `9999`          | Port to listen on                           |
| `--shared-promise-path <path>` |       | —               | Absolute path to `sharedPromise` FSM folder |
| `--shared-fsm-path <path>`     |       | —               | Absolute path to `sharedFsm` FSM folder     |
| `--fsm-path <path>`            |       | —               | Absolute path to `fsm` FSM folder           |
| `--env-file <path>`            |       | `./.env`        | Path to `.env` file                         |
| `--help`                       | `-h`  |                 | Show help and exit                          |

FSM folder flags are all optional — omit any you don't need. The server starts
without loading any FSM definitions if no paths are given.

## Examples

### Minimal (all config from `.env`)

```bash
deno run --allow-all src/cli/index.ts
```

### Override DB URL and port

```bash
deno run --allow-all src/cli/index.ts \
  --db-url postgres://user:pass@localhost:5432/mydb \
  --port 8080
```

### Full config with all FSM folder paths

```bash
deno run --allow-all src/cli/index.ts \
  --db-url postgres://user:pass@localhost:5432/mydb \
  --url-path-prefix /api/fsm \
  --port 8080 \
  --shared-promise-path /abs/path/to/sharedPromise \
  --shared-fsm-path /abs/path/to/sharedFSM \
  --fsm-path /abs/path/to/fsm
```

### Custom env file

```bash
deno run --allow-all src/cli/index.ts \
  --env-file /etc/myapp/.env \
  --fsm-path /abs/path/to/fsm
```

### Using the deno task shortcut

```bash
deno task cli --db-url postgres://... --fsm-path /abs/path/to/fsm
```

## API Docs

Once running, the OpenAPI reference UI is available at:

```
http://localhost:<port><url-path-prefix>/docs
```

For example with defaults: `http://localhost:9999/fsm/docs`

## Graceful Shutdown

Send `SIGINT` (Ctrl+C) or `SIGTERM` to stop the server gracefully. Press Ctrl+C
a second time to force-exit immediately.
