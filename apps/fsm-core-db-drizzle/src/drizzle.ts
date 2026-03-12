import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "./pg-client";


export const db = drizzle({ client: pool });
