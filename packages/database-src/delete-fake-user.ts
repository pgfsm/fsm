import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";

dotenv.config({ path: "./../../.env" });

/**
 * Deletes all fake users in Supabase Auth using the admin API.
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set in environment variables.
 */
export async function deleteFakeUsersInSupabaseAuth() {
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

  // Fetch all users
  const { data: users, error: fetchError } = await supabase.auth.admin
    .listUsers();
  if (fetchError) {
    throw new Error(`Error fetching users: ${fetchError.message}`);
  }

  // console.log('deleteFakeUsersInSupabaseAuth: Found users:', users);
  // Filter fake users by email pattern
  const fakeUsers = users.users.filter((user) =>
    user.email?.startsWith("fakeuser")
  );

  // Delete each fake user
  const results = [];
  for (const user of fakeUsers) {
    const { data, error } = await supabase.auth.admin.deleteUser(user.id);
    results.push({ data, error });
  }

  return results;
}
deleteFakeUsersInSupabaseAuth()
  .then((results) => {
    console.log("Fake users deleted:", results);
  })
  .catch((err) => {
    console.error("Error deleting fake users:", err);
  });
