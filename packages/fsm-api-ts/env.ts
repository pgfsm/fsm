import { z } from "zod";

// Reads the process environment once, at import. The CLI loads --env-file
// (default ./.env) into it first; the dev entry (deno.ts) gets it from
// `deno run --env-file`.

const LogTapeLevel = z.enum([
  "debug",
  "info",
  "warning",
  "error",
  "fatal",
  "silent",
]);

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(9999),
  LOG_LEVEL: LogTapeLevel.default("info"),
  LOG_LEVEL_API: LogTapeLevel.optional(),
  LOG_LEVEL_WORKER: LogTapeLevel.optional(),
  LOG_LEVEL_COMPILER: LogTapeLevel.optional(),
  LOG_LEVEL_DB: LogTapeLevel.optional(),
  DB_TYPE: z.enum(["postgres", "supabase", "supabase_and_postgres"]).default(
    "postgres",
  ),
  // Only for DB_TYPE=supabase / supabase_and_postgres (with --no-auth).
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().url(),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
  PARSEFSM: z.string().optional().default("false"),
  OTEL_DENO: z.string().optional().default("false"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("pgfsm-api"),
  // SPEC-009 §3. Auth is on unless PGFSM_NO_AUTH=true (refused in production).
  PGFSM_NO_AUTH: z.enum(["true", "false"]).default("false").transform((v) =>
    v === "true"
  ),
  PGFSM_ENABLE_ADMIN_API: z.enum(["true", "false"]).default("false")
    .transform((v) => v === "true"),
  // Key-verification cache; also the upper bound on revocation latency.
  PGFSM_AUTH_CACHE_TTL_MS: z.coerce.number().int().min(0).max(30_000)
    .default(30_000),
}).superRefine((input, ctx) => {
  if (input.DB_TYPE !== "postgres") {
    for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY"] as const) {
      if (!input[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Must be set when DB_TYPE is '${input.DB_TYPE}'`,
        });
      }
    }
  }
  if (input.NODE_ENV === "production" && !input.DATABASE_AUTH_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.invalid_type,
      expected: "string",
      received: "undefined",
      path: ["DATABASE_AUTH_TOKEN"],
      message: "Must be set when NODE_ENV is 'production'",
    });
  }
});

export type env = z.infer<typeof EnvSchema>;

// eslint-disable-next-line ts/no-redeclare
const { data: env, error } = EnvSchema.safeParse(process.env);

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export default env!;
