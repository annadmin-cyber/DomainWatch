import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicSupabaseConfig } from "@/lib/env";

/**
 * Privileged client (bypasses RLS). Server-only: used by the scheduled monitor
 * and by server code after the owner has been verified.
 */
export function createAdminClient() {
  const cfg = publicSupabaseConfig();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!cfg || !secret) throw new Error("Supabase server credentials are not configured");
  return createClient(cfg.url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
