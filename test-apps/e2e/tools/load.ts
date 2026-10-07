// Load tool for the SPEC-007 acceptance suite (#458), two kinds of load:
//
// - `enqueue` fills one language's `loadWork` actor queue directly: the
//   activity tier alone (claim, gateway, workers, archive), for throughput,
//   loss and connection counts. Messages name the system queue as their
//   parent, so the gateway archives them without notifying an FSM instance
//   (fsm_core.archive_event_from_fsm_async_operation_type_worker_v2), and each
//   processed message leaves a row in fsm_core.fsm_async_operation_queue_event_logs.
// - `instances` creates loadTest FSM instances (create_fsm_instance_from_name_v2):
//   the full cycle, through the sync worker, all four actors and back. Each
//   finished instance means four actor results reached their FSM. Needs the
//   FSM loaded and a sync worker running.
//
//   deno run -A test-apps/e2e/tools/load.ts enqueue --language go --count 200 --work-ms 500
//   deno run -A test-apps/e2e/tools/load.ts instances --count 50 --run-id <id>
//   deno run -A test-apps/e2e/tools/load.ts stats --run-id <id> [--wait 300] [--json]
//
// Needs DATABASE_URL (Postgres with the fsm_core migrations), e.g. a
// `kubectl port-forward` to the kind cluster's test Postgres.

import { parseArgs } from "@std/cli/parse-args";
import pg from "pg";

const LANGUAGES = ["typescript", "python", "rust", "go"] as const;
type Language = (typeof LANGUAGES)[number];

const IDENTITY = {
  parentFsmName: "loadTest",
  parentFsmVersion: "v01",
  asyncOperationType: "internalAsyncOperation",
  asyncOperationName: "loadWork",
  asyncOperationVersion: "v01",
};

interface LanguageStats {
  language: Language;
  queue: string;
  /** Messages of this run that exist (still queued or archived). */
  sent: number;
  /** Still on the queue (not yet processed, or waiting for redelivery). */
  queued: number;
  /** Distinct messages logged as succeeded. */
  succeeded: number;
  /** Distinct messages logged as failed (actor error, or out of delivery attempts). */
  failed: number;
  /** Extra log rows: a message processed more than once. */
  duplicates: number;
  /** Archived messages that were delivered more than once (read_ct > 1). */
  redelivered: number;
  /** Sent, but neither logged nor still queued. */
  lost: number;
  /** Succeeded messages per minute, first to last finish (null below 2). */
  perMinute: number | null;
  /** Succeeded messages per worker (the actor reports its hostname). */
  byWorker: Record<string, number>;
}

interface InstanceStats {
  /** loadTest instances created for this run. */
  created: number;
  /** Instances whose status is `done` (reached `Finished`). */
  done: number;
  /** Instances per status (`null` while the first macrostep hasn't run). */
  byStatus: Record<string, number>;
}

function usage(): never {
  console.error(`usage:
  load.ts enqueue --language <${
    LANGUAGES.join("|")
  }> --count <n> [--work-ms <ms>] [--run-id <id>]
  load.ts instances --count <n> [--run-id <id>]
  load.ts stats --run-id <id> [--language <l>]... [--wait <seconds>] [--json]`);
  Deno.exit(2);
}

function asLanguage(value: unknown): Language {
  if (!LANGUAGES.includes(value as Language)) {
    console.error(`unknown language: ${value}`);
    usage();
  }
  return value as Language;
}

async function queueName(db: pg.Pool, language: Language): Promise<string> {
  const { rows } = await db.query(
    "SELECT fsm_core.compute_async_operation_queue_name_v2($1, $2, $3, $4, $5, $6) AS q",
    [...Object.values(IDENTITY), language],
  );
  return rows[0].q;
}

/** pgmq's table for a queue ("q") or its archive ("a"), as a quoted identifier. */
async function pgmqTable(
  db: pg.Pool,
  queue: string,
  kind: "q" | "a",
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT format('pgmq.%I', c.relname) AS t
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'pgmq' AND c.relkind IN ('r', 'p')
        AND lower(c.relname) = lower($1)`,
    [`${kind}_${queue}`],
  );
  return rows[0]?.t ?? null;
}

async function enqueue(
  db: pg.Pool,
  language: Language,
  count: number,
  workMs: number,
  runId: string,
): Promise<void> {
  const queue = await queueName(db, language);
  await db.query("SELECT pgmq.create($1)", [queue]);
  const { rows } = await db.query(
    `SELECT min(id) AS first, max(id) AS last FROM (
       SELECT pgmq.send($1, jsonb_build_object(
         'eventData', jsonb_build_object(
           'eventPayload', jsonb_build_object('n', n, 'runId', $2::text, 'workMs', $3::int),
           'actionType', 'xstate.invoke'),
         'sendToParentQueueId', fsm_core.pg_system_queue_uuid()::text,
         'sendToParentQueueIdEventName', 'loadTest')) AS id
       FROM generate_series(1, $4::int) n) sent`,
    [queue, runId, workMs, count],
  );
  console.log(JSON.stringify({
    runId,
    language,
    queue,
    count,
    workMs,
    firstMsgId: Number(rows[0].first),
    lastMsgId: Number(rows[0].last),
  }));
}

/**
 * Creates `count` loadTest instances, tagged with the run id in their context
 * so `stats` can find them. Their actors get no per-instance input (fsm.json
 * keeps no invoke input function), so they do no work: this is about the
 * cycle completing, not throughput.
 */
async function createInstances(
  db: pg.Pool,
  count: number,
  runId: string,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT count(*) AS created FROM (
       SELECT fsm_core.create_fsm_instance_from_name_v2(
         'loadTest', 'v01', jsonb_build_object('e2eRunId', $1::text))
       FROM generate_series(1, $2::int)) made`,
    [runId, count],
  );
  console.log(JSON.stringify({ runId, instances: Number(rows[0].created) }));
}

async function instanceStats(
  db: pg.Pool,
  runId: string,
): Promise<InstanceStats> {
  const { rows } = await db.query(
    `SELECT coalesce(fsm_instance_status #>> '{}', 'null') AS status, count(*) AS n
       FROM fsm_core.fsm_instance
      WHERE fsm_name = 'loadTest' AND fsm_version = 'v01'
        AND fsm_instance_context->>'e2eRunId' = $1
      GROUP BY 1`,
    [runId],
  );
  const byStatus = Object.fromEntries(
    rows.map((
      row: { status: string; n: string },
    ) => [row.status, Number(row.n)]),
  );
  return {
    created: Object.values(byStatus).reduce((a, b) => a + b, 0),
    done: byStatus.done ?? 0,
    byStatus,
  };
}

async function statsFor(
  db: pg.Pool,
  language: Language,
  runId: string,
): Promise<LanguageStats> {
  const queue = await queueName(db, language);
  const empty: LanguageStats = {
    language,
    queue,
    sent: 0,
    queued: 0,
    succeeded: 0,
    failed: 0,
    duplicates: 0,
    redelivered: 0,
    lost: 0,
    perMinute: null,
    byWorker: {},
  };
  const [q, a] = [
    await pgmqTable(db, queue, "q"),
    await pgmqTable(db, queue, "a"),
  ];
  if (!q || !a) return empty;

  const runFilter = "message->'eventData'->'eventPayload'->>'runId' = $1";
  const { rows: [counts] } = await db.query(
    `WITH queued AS (SELECT msg_id FROM ${q} WHERE ${runFilter}),
          archived AS (SELECT msg_id, read_ct FROM ${a} WHERE ${runFilter}),
          run AS (SELECT msg_id FROM queued UNION SELECT msg_id FROM archived),
          logs AS (
            SELECT l.async_operation_queue_msg_id AS msg_id, l.event_status,
                   l.execution_finished_at, l.event_output->>'worker' AS worker
              FROM fsm_core.fsm_async_operation_queue_event_logs l
             WHERE l.async_operation_queue_name = $2
               AND l.async_operation_queue_msg_id IN (SELECT msg_id FROM run))
     SELECT (SELECT count(*) FROM run) AS sent,
            (SELECT count(*) FROM queued) AS queued,
            (SELECT count(DISTINCT msg_id) FROM logs WHERE event_status = 'succeeded') AS succeeded,
            (SELECT count(DISTINCT msg_id) FROM logs WHERE event_status <> 'succeeded') AS failed,
            (SELECT count(*) - count(DISTINCT msg_id) FROM logs) AS duplicates,
            (SELECT count(*) FROM archived WHERE read_ct > 1) AS redelivered,
            (SELECT count(*) FROM run WHERE msg_id NOT IN (SELECT msg_id FROM logs)
                AND msg_id NOT IN (SELECT msg_id FROM queued)) AS lost,
            (SELECT extract(epoch FROM max(execution_finished_at) - min(execution_finished_at))
               FROM logs WHERE event_status = 'succeeded') AS span_s,
            (SELECT coalesce(jsonb_object_agg(worker, n), '{}'::jsonb) FROM (
               SELECT coalesce(worker, '?') AS worker, count(DISTINCT msg_id) AS n
                 FROM logs WHERE event_status = 'succeeded' GROUP BY 1) w) AS by_worker`,
    [runId, queue],
  );
  const succeeded = Number(counts.succeeded);
  const spanS = counts.span_s === null ? 0 : Number(counts.span_s);
  return {
    ...empty,
    sent: Number(counts.sent),
    queued: Number(counts.queued),
    succeeded,
    failed: Number(counts.failed),
    duplicates: Number(counts.duplicates),
    redelivered: Number(counts.redelivered),
    lost: Number(counts.lost),
    // n finishes span n-1 intervals.
    perMinute: succeeded >= 2 && spanS > 0
      ? Math.round(((succeeded - 1) / spanS) * 60 * 10) / 10
      : null,
    byWorker: Object.fromEntries(
      Object.entries(counts.by_worker as Record<string, string>).map((
        [worker, n],
      ) => [worker, Number(n)]),
    ),
  };
}

const done = (s: LanguageStats) =>
  s.sent > 0 && s.queued === 0 && s.succeeded + s.failed + s.lost >= s.sent;

async function stats(
  db: pg.Pool,
  runId: string,
  languages: Language[],
  waitS: number,
  json: boolean,
): Promise<void> {
  const deadline = Date.now() + waitS * 1000;
  let all: LanguageStats[];
  let instances: InstanceStats;
  while (true) {
    all = [];
    for (const language of languages) {
      all.push(await statsFor(db, language, runId));
    }
    instances = await instanceStats(db, runId);
    const active = all.filter((s) => s.sent > 0);
    const queuesDone = active.every(done);
    const instancesDone = instances.done === instances.created;
    const anything = active.length > 0 || instances.created > 0;
    if (waitS <= 0 || (anything && queuesDone && instancesDone)) break;
    if (Date.now() > deadline) {
      console.error(`run ${runId} not drained after ${waitS}s`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (json) {
    console.log(JSON.stringify({ runId, languages: all, instances }));
    return;
  }
  console.log(`run ${runId}`);
  if (instances.created > 0) {
    console.log(
      `  instances  created ${instances.created}, done ${instances.done} ${
        JSON.stringify(instances.byStatus)
      }`,
    );
  }
  for (const s of all.filter((s) => s.sent > 0)) {
    console.log(
      `  ${
        s.language.padEnd(10)
      } sent ${s.sent}, queued ${s.queued}, succeeded ${s.succeeded}, failed ${s.failed}, duplicates ${s.duplicates}, redelivered ${s.redelivered}, lost ${s.lost}, ${
        s.perMinute ?? "-"
      }/min ${JSON.stringify(s.byWorker)}`,
    );
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["language", "count", "work-ms", "run-id", "wait"],
    boolean: ["json"],
    collect: ["language"],
  });
  const command = args._[0];
  const url = Deno.env.get("DATABASE_URL");
  if (!url) {
    console.error("DATABASE_URL is not set");
    Deno.exit(2);
  }
  const db = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const languages = (args.language as string[]).map(asLanguage);
    if (command === "enqueue") {
      if (languages.length !== 1 || !args.count) usage();
      await enqueue(
        db,
        languages[0],
        Number(args.count),
        Number(args["work-ms"] ?? 0),
        args["run-id"] ?? crypto.randomUUID(),
      );
    } else if (command === "instances") {
      if (!args.count) usage();
      await createInstances(
        db,
        Number(args.count),
        args["run-id"] ?? crypto.randomUUID(),
      );
    } else if (command === "stats") {
      if (!args["run-id"]) usage();
      await stats(
        db,
        args["run-id"],
        languages.length > 0 ? languages : [...LANGUAGES],
        Number(args.wait ?? 0),
        args.json,
      );
    } else {
      usage();
    }
  } finally {
    await db.end();
  }
}
