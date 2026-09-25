import "server-only";
import { appBaseUrl } from "@/lib/env";
import { telegramToken } from "@/lib/notify/telegram";
import { RdapProvider } from "@/lib/providers/rdap/provider";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EngineDeps } from "./engine";
import { SupabaseMonitorRepository } from "./supabase-repository";

/** Maximum number of chained continuation invocations per scheduled run. */
export const MAX_CHAIN_DEPTH = 10;

export function productionDeps(): EngineDeps {
  return {
    repo: new SupabaseMonitorRepository(createAdminClient()),
    provider: new RdapProvider(),
    telegramToken: telegramToken(),
  };
}

/** Ask this deployment to process the remaining due domains in a fresh invocation. */
export async function triggerContinuation(chainId: string, depth: number): Promise<boolean> {
  const base = appBaseUrl();
  const secret = process.env.CRON_SECRET?.trim();
  if (!base || !secret) {
    console.warn("Continuation skipped: APP_URL/VERCEL_PROJECT_PRODUCTION_URL or CRON_SECRET missing");
    return false;
  }
  try {
    const res = await fetch(`${base}/api/cron/monitor?chain=${encodeURIComponent(chainId)}&depth=${depth}`, {
      headers: { authorization: `Bearer ${secret}` },
      // Following a redirect (e.g. example.com -> www.example.com) would drop
      // the Authorization header, so a redirect counts as a failure instead.
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (res.ok) return true;
    const location = res.headers.get("location");
    console.warn(
      `Continuation request returned HTTP ${res.status}` +
        (location ? ` (redirect to ${location}; set APP_URL to the final production URL)` : ""),
    );
    return false;
  } catch (err) {
    console.warn("Continuation request failed:", err);
    return false;
  }
}
