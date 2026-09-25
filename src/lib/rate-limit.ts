import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * "error" means the limiter itself is unavailable (secret key missing or
 * wrong, database unreachable, migration not applied). Each caller decides
 * whether that fails open or closed.
 */
export type RateLimitResult = "allowed" | "limited" | "error";

/** Fixed-window rate limit stored in Postgres (survives across serverless instances). */
export async function allowRequest(key: string, max: number, windowSeconds: number): Promise<RateLimitResult> {
  try {
    const db = createAdminClient();
    const { data, error } = await db.rpc("hit_rate_limit", {
      p_key: key,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      console.error("Rate limit check failed:", error.message);
      return "error";
    }
    return data === true ? "allowed" : "limited";
  } catch (err) {
    console.error("Rate limit check failed:", err instanceof Error ? err.message : err);
    return "error";
  }
}
