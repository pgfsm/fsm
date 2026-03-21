import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { SupabaseClient } from "@supabase/supabase-js";
import type { Context, MiddlewareHandler } from "hono";
import { env } from "hono/adapter";
import { setCookie } from "hono/cookie";
import type { Database } from "../../fsm-core-db-ts/src/database.types.ts";

declare module "hono" {
  interface ContextVariableMap {
    supabase: SupabaseClient;
  }
}



type SupabaseEnv = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
};

export const supabaseMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    const supabaseEnv = env<SupabaseEnv>(c);

    const supabaseUrl = supabaseEnv.SUPABASE_URL;
    const supabaseAnonKey = supabaseEnv.SUPABASE_ANON_KEY;

    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL missing!");
    }

    if (!supabaseAnonKey) {
      throw new Error("SUPABASE_ANON_KEY missing!");
    }

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
       db: {
        schema: 'fsm_core', // Specify your custom schema name here
      },
      cookies: {
        getAll() {
          return parseCookieHeader(c.req.header("Cookie") ?? "");
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            setCookie(c, name, value, options)
          );
        },
      },
    });

    c.set("supabase", supabase as SupabaseClient<Database>);

    await next();
  };
};

export const getSupabase = (c: Context) => {
  return c.get("supabase") as SupabaseClient<Database>;
};