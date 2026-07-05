import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { validateAsyncOperationAndLoadToDb } from "./validate-async-operation-logic-and-load-to-db.ts";
import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });

(async () => {
  const sharedPromisefolderPath = "apps/fsm-core-example/sharedPromise";

  const deps = { db: pool, useSupabase: false };

  const skipSharedPromiseDirs = [""];

  const outputSharedPromise = await validateAsyncOperationAndLoadToDb(
    deps,
    sharedPromisefolderPath,
    "sharedPromise",
    skipSharedPromiseDirs,
    [],
  );
  logger.info("final output: {output}", { output: outputSharedPromise });

  await pool.end();
})();
