import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: "./../../.env" });

/**
 * Creates 10 fake users in Supabase Auth using the admin API.
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set in environment variables.
 */
export async function createFakeUsersInSupabaseAuth() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env variable",
    );
  }
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const fakeUsers = Array.from({ length: 3 }).map((_, i) => ({
    email: `fakeuser${i + 1}@example.com`,
    password: `fakeuser${i + 1}@example.com`,
    email_confirm: true,
    user_metadata: {
      full_name: `Fake User ${i + 1}`,
      avatar_url: `https://api.dicebear.com/7.x/identicon/svg?seed=${i + 1}`,
    },
  }));

  const results = [];
  for (const user of fakeUsers) {
    const { data, error } = await supabase.auth.admin.createUser(user);
    results.push({ data, error });
  }
  return results;
}

createFakeUsersInSupabaseAuth()
  .then((results) => {
    console.log("Fake users created:", results);
  })
  .catch((err) => {
    console.error("Error creating fake users:", err);
  });
