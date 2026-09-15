import type { Pool } from "pg";

export interface LatencyStats {
  count: number;
  durationMs: number;
  throughputPerSec: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorCount: number;
}

/** Collects per-call-type latency samples for one scenario run. */
export class Recorder {
  #samples = new Map<string, number[]>();
  #errors = new Map<string, number>();
  #firstAt: number | null = null;
  #lastAt = 0;

  /** Times `fn`, recording its latency under `type`. Rethrows on failure. */
  async time<T>(type: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    if (this.#firstAt === null) this.#firstAt = start;
    try {
      return await fn();
    } catch (err) {
      this.#errors.set(type, (this.#errors.get(type) ?? 0) + 1);
      throw err;
    } finally {
      const elapsed = performance.now() - start;
      const list = this.#samples.get(type) ?? [];
      list.push(elapsed);
      this.#samples.set(type, list);
      this.#lastAt = performance.now();
    }
  }

  summary(): Record<string, LatencyStats> {
    const out: Record<string, LatencyStats> = {};
    const wallMs = this.#firstAt === null ? 0 : this.#lastAt - this.#firstAt;
    for (const [type, samples] of this.#samples) {
      const sorted = [...samples].sort((a, b) => a - b);
      const count = sorted.length;
      out[type] = {
        count,
        durationMs: wallMs,
        throughputPerSec: wallMs > 0 ? (count / wallMs) * 1000 : 0,
        meanMs: sorted.reduce((a, b) => a + b, 0) / count,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        errorCount: this.#errors.get(type) ?? 0,
      };
    }
    return out;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(p * (sorted.length - 1)),
  );
  return sorted[idx];
}

export interface PgStatActivitySnapshot {
  total: number;
  active: number;
  idle: number;
  idleInTransaction: number;
}

export async function snapshotPgStatActivity(
  pool: Pool,
): Promise<PgStatActivitySnapshot> {
  const res = await pool.query<
    { state: string | null; count: string }
  >(
    `SELECT state, count(*) AS count
     FROM pg_stat_activity
     WHERE datname = current_database()
     GROUP BY state`,
  );
  const snapshot: PgStatActivitySnapshot = {
    total: 0,
    active: 0,
    idle: 0,
    idleInTransaction: 0,
  };
  for (const row of res.rows) {
    const count = Number(row.count);
    snapshot.total += count;
    if (row.state === "active") snapshot.active += count;
    else if (row.state === "idle") snapshot.idle += count;
    else if (row.state?.startsWith("idle in transaction")) {
      snapshot.idleInTransaction += count;
    }
  }
  return snapshot;
}

export interface PgLocksSnapshot {
  byMode: Record<string, number>;
  waiting: number;
}

export async function snapshotPgLocks(pool: Pool): Promise<PgLocksSnapshot> {
  const res = await pool.query<
    { mode: string; granted: boolean; count: string }
  >(
    `SELECT mode, granted, count(*) AS count
     FROM pg_locks
     GROUP BY mode, granted`,
  );
  const snapshot: PgLocksSnapshot = { byMode: {}, waiting: 0 };
  for (const row of res.rows) {
    const count = Number(row.count);
    snapshot.byMode[row.mode] = (snapshot.byMode[row.mode] ?? 0) + count;
    if (!row.granted) snapshot.waiting += count;
  }
  return snapshot;
}

export interface RunResult {
  scenario: string;
  options: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  latency: Record<string, LatencyStats>;
  pgStatActivityBefore: PgStatActivitySnapshot;
  pgStatActivityAfter: PgStatActivitySnapshot;
  pgLocksAfter: PgLocksSnapshot;
}

export async function writeResults(result: RunResult): Promise<string> {
  const resultsDir = "scripts/stress/results";
  await Deno.mkdir(resultsDir, { recursive: true });
  const ts = result.startedAt.replace(/[:.]/g, "-");
  const path = `${resultsDir}/${result.scenario}-${ts}.json`;
  await Deno.writeTextFile(path, JSON.stringify(result, null, 2));
  return path;
}

export function printSummary(result: RunResult): void {
  console.log(`\n=== ${result.scenario} ===`);
  console.log(`options: ${JSON.stringify(result.options)}`);
  console.log(
    `connections before: ${result.pgStatActivityBefore.total} ` +
      `(active ${result.pgStatActivityBefore.active}, idle ${result.pgStatActivityBefore.idle})`,
  );
  console.log(
    `connections after:  ${result.pgStatActivityAfter.total} ` +
      `(active ${result.pgStatActivityAfter.active}, idle ${result.pgStatActivityAfter.idle}, ` +
      `idle-in-txn ${result.pgStatActivityAfter.idleInTransaction})`,
  );
  console.log(
    `locks after: ${JSON.stringify(result.pgLocksAfter.byMode)} ` +
      `(waiting: ${result.pgLocksAfter.waiting})`,
  );
  console.table(
    Object.fromEntries(
      Object.entries(result.latency).map(([type, stats]) => [
        type,
        {
          count: stats.count,
          errors: stats.errorCount,
          "req/s": stats.throughputPerSec.toFixed(1),
          "mean ms": stats.meanMs.toFixed(1),
          "p50 ms": stats.p50Ms.toFixed(1),
          "p95 ms": stats.p95Ms.toFixed(1),
          "p99 ms": stats.p99Ms.toFixed(1),
        },
      ]),
    ),
  );
}
