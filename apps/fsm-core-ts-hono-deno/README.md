# fsm-core-ts-hono-deno — REST API

The HTTP gateway for the FSM framework. Built with [Hono](https://hono.dev/),
runs on Deno.

## What it does

- Creates FSM instances (`POST /fsm/fsm`)
- Dispatches events to running instances (`POST /fsm/fsm/send`)
- Starts and manages queue workers (`POST /fsm/fsmworker`)
- Starts promise workers for async actors (`POST /fsm/fsmpromise`)
- Serves OpenAPI docs at `/fsm/docs`

The server holds no FSM business logic. It translates HTTP requests into
database calls and enqueues events for workers to process asynchronously.

## How to run

```bash
deno run --allow-all --env-file=.env --watch main.ts
```

Default port: `9999`.

## Environment variables

| Variable                    | Required          | Description                                            |
| --------------------------- | ----------------- | ------------------------------------------------------ |
| `DATABASE_URL`              | yes               | PostgreSQL connection string                           |
| `DB_TYPE`                   | yes               | `postgres`, `supabase`, or `supabase_and_postgres`     |
| `SUPABASE_URL`              | if using Supabase | Supabase project URL                                   |
| `SUPABASE_SERVICE_ROLE_KEY` | if using Supabase | Service role key                                       |
| `SUPABASE_ANON_KEY`         | if using Supabase | Anon key                                               |
| `PORT`                      | no                | Server port (default: `9999`)                          |
| `LOG_LEVEL`                 | no                | Pino log level (`info`, `debug`, `trace`, …)           |
| `CORS_ORIGIN`               | no                | Allowed CORS origin (default: `http://localhost:5173`) |
| `DATABASE_AUTH_TOKEN`       | production only   | Required when `NODE_ENV=production`                    |

## Routes

| Method | Path                               | Description                                 |
| ------ | ---------------------------------- | ------------------------------------------- |
| `GET`  | `/fsm/fsm`                         | List all FSM instances                      |
| `POST` | `/fsm/fsm`                         | Create a new FSM instance                   |
| `POST` | `/fsm/fsm/send`                    | Send an event to an instance                |
| `GET`  | `/fsm/fsmworker`                   | List active worker locks                    |
| `POST` | `/fsm/fsmworker`                   | Start a worker for a queue                  |
| `GET`  | `/fsm/fsmpromise`                  | List active promise workers                 |
| `POST` | `/fsm/fsmpromise`                  | Start a promise worker                      |
| `POST` | `/fsm/fsmpromise/create-and-start` | Create a promise queue and start its worker |

## Tests

```bash
deno test
```

## Key files

| File                 | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `main.ts`            | Deno entry point                                         |
| `lib/create-app.ts`  | App factory — middleware, plugin loading, route mounting |
| `env.ts`             | Zod-validated environment config                         |
| `routes/fsm/`        | FSM instance CRUD and event dispatch                     |
| `routes/fsmworker/`  | Worker lifecycle                                         |
| `routes/fsmpromise/` | Promise worker lifecycle                                 |
