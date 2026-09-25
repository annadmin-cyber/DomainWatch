import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Fixed-window rate limit stored in Postgres (survives across serverless instances). */
export async function allowRequest(key: string, max: number, windowSeconds: number): Promise<boolean> {
  const db = createAdminClient();
  const { data, error } = await db.rpc("hit_rate_limit", {
    p_key: key,
    p_max: max,
    p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error("Rate limit check failed:", error.message);
    return false; // fail closed
  }
  return data === true;
}
