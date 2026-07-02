import { config } from "dotenv";
import { z } from "zod";

// Load environment variables
config({ path: "./../../.env" });

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
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  DATABASE_URL: z.string().url(),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
  PARSEFSM: z.string().optional().default("false"),
  OTEL_DENO: z.string().optional().default("false"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("pgfsm-api"),
}).superRefine((input, ctx) => {
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
console.log("✅ Environment variables loaded successfully");
