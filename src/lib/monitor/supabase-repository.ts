import type { SupabaseClient } from "@supabase/supabase-js";
import type { LookupResult } from "@/lib/providers/types";
import type { MonitorRepository, PendingDelivery, RunStatus, RunSummary, RunTrigger, TelegramSettings } from "./repository";
import type { DomainState, DomainUpdate, NewEvent } from "./transition";

const STATE_COLUMNS =
  "id, fqdn, suffix, is_mine, status, last_conclusive_status, last_conclusive_at, last_confirmed_unregistered_at, baseline_status, consecutive_failures";

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? "unknown database error"}`);
}

function toState(row: Record<string, unknown>): DomainState {
  return {
    id: row.id as string,
    fqdn: row.fqdn as string,
    suffix: row.suffix as string,
    is_mine: Boolean(row.is_mine),
    status: row.status as DomainState["status"],
    last_conclusive_status: (row.last_conclusive_status as DomainState["last_conclusive_status"]) ?? null,
    last_conclusive_at: (row.last_conclusive_at as string | null) ?? null,
    last_confirmed_unregistered_at: (row.last_confirmed_unregistered_at as string | null) ?? null,
    baseline_status: (row.baseline_status as DomainState["baseline_status"]) ?? null,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
  };
}

/** Supabase implementation; expects a service-role (secret key) client. */
export class SupabaseMonitorRepository implements MonitorRepository {
  constructor(private db: SupabaseClient) {}

  async createRun(trigger: RunTrigger, chainId: string | null, depth: number) {
    const { data, error } = await this.db
      .from("monitor_runs")
      .insert({ trigger, chain_id: chainId, chain_depth: depth })
      .select("id")
      .single();
    if (error || !data) fail("createRun", error);
    return data.id as string;
  }

  async finishRun(runId: string, status: RunStatus, summary: RunSummary) {
    const { error } = await this.db
      .from("monitor_runs")
      .update({ status, finished_at: new Date().toISOString(), ...summary })
      .eq("id", runId);
    if (error) fail("finishRun", error);
  }

  async acquireLock(runId: string, ttlSeconds: number) {
    const { data, error } = await this.db.rpc("acquire_monitor_lock", { p_run_id: runId, p_ttl_seconds: ttlSeconds });
    if (error) fail("acquireLock", error);
    return data === true;
  }

  async releaseLock(runId: string) {
    const { error } = await this.db.rpc("release_monitor_lock", { p_run_id: runId });
    if (error) fail("releaseLock", error);
  }

  async claimDue(limit: number, dueBefore: Date, claimSeconds: number) {
    const { data, error } = await this.db.rpc("claim_due_domains", {
      p_limit: limit,
      p_due_before: dueBefore.toISOString(),
      p_claim_seconds: claimSeconds,
    });
    if (error) fail("claimDue", error);
    return ((data ?? []) as Record<string, unknown>[]).map(toState);
  }

  async claimOne(id: string, claimSeconds: number) {
    const nowIso = new Date().toISOString();
    const { data, error } = await this.db
      .from("monitored_domains")
      .update({ claimed_until: new Date(Date.now() + claimSeconds * 1000).toISOString() })
      .eq("id", id)
      .or(`claimed_until.is.null,claimed_until.lt."${nowIso}"`)
      .select(STATE_COLUMNS)
      .maybeSingle();
    if (error) fail("claimOne", error);
    return data ? toState(data) : null;
  }

  async releaseClaims(ids: string[]) {
    if (ids.length === 0) return;
    const { error } = await this.db.from("monitored_domains").update({ claimed_until: null }).in("id", ids);
    if (error) fail("releaseClaims", error);
  }

  async countDue(dueBefore: Date) {
    const { count, error } = await this.db
      .from("monitored_domains")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true)
      .or(`last_checked_at.is.null,last_checked_at.lt."${dueBefore.toISOString()}"`);
    if (error) fail("countDue", error);
    return count ?? 0;
  }

  async saveCheck(domainId: string, runId: string | null, result: LookupResult, confirmation: boolean, at: Date) {
    const { error } = await this.db.from("check_results").insert({
      monitored_domain_id: domainId,
      run_id: runId,
      checked_at: at.toISOString(),
      status: result.status,
      source: result.source,
      http_status: result.httpStatus ?? null,
      registration_date: result.registrationDate ?? null,
      error: result.error ?? null,
      duration_ms: Math.round(result.durationMs),
      confirmation,
    });
    if (error) fail("saveCheck", error);
  }

  async applyUpdate(domainId: string, update: DomainUpdate) {
    const { error } = await this.db
      .from("monitored_domains")
      .update({ ...update, claimed_until: null })
      .eq("id", domainId);
    if (error) fail("applyUpdate", error);
  }

  async insertEvent(domainId: string, event: NewEvent, detectedAt: Date) {
    const { data, error } = await this.db
      .from("status_events")
      .upsert(
        {
          monitored_domain_id: domainId,
          event_type: event.event_type,
          previous_status: event.previous_status,
          new_status: event.new_status,
          previous_confirmed_unregistered_at: event.previous_confirmed_unregistered_at,
          registration_date: event.registration_date,
          detected_at: detectedAt.toISOString(),
          message: event.message,
          dedupe_key: event.dedupe_key,
        },
        { onConflict: "dedupe_key", ignoreDuplicates: true },
      )
      .select("id");
    if (error) fail("insertEvent", error);
    if (data && data.length > 0) return { id: data[0].id as string, created: true };
    const { data: existing, error: readErr } = await this.db
      .from("status_events")
      .select("id")
      .eq("dedupe_key", event.dedupe_key)
      .single();
    if (readErr || !existing) fail("insertEvent (existing)", readErr);
    return { id: existing.id as string, created: false };
  }

  async createNotification(eventId: string, kind: "alert" | "info", title: string, body: string) {
    const { data, error } = await this.db
      .from("notifications")
      .upsert({ event_id: eventId, kind, title, body }, { onConflict: "event_id", ignoreDuplicates: true })
      .select("id");
    if (error) fail("createNotification", error);
    if (data && data.length > 0) return data[0].id as string;
    const { data: existing, error: readErr } = await this.db
      .from("notifications")
      .select("id")
      .eq("event_id", eventId)
      .single();
    if (readErr || !existing) fail("createNotification (existing)", readErr);
    return existing.id as string;
  }

  async queueDelivery(notificationId: string, channel: "telegram") {
    const { error } = await this.db
      .from("notification_deliveries")
      .upsert({ notification_id: notificationId, channel }, { onConflict: "notification_id,channel", ignoreDuplicates: true });
    if (error) fail("queueDelivery", error);
  }

  async listPendingDeliveries(limit: number, maxAttempts: number, staleSendingMs: number): Promise<PendingDelivery[]> {
    const staleIso = new Date(Date.now() - staleSendingMs).toISOString();
    const { data, error } = await this.db
      .from("notification_deliveries")
      .select("id, notification_id, attempts, notifications!inner(title, body, is_demo)")
      .or(`status.in.(pending,failed),and(status.eq.sending,updated_at.lt."${staleIso}")`)
      .lt("attempts", maxAttempts)
      .eq("notifications.is_demo", false)
      .order("updated_at")
      .limit(limit);
    if (error) fail("listPendingDeliveries", error);
    return (data ?? []).map((row) => {
      const n = (Array.isArray(row.notifications) ? row.notifications[0] : row.notifications) as {
        title: string;
        body: string;
      };
      return {
        id: row.id as string,
        notification_id: row.notification_id as string,
        attempts: row.attempts as number,
        title: n.title,
        body: n.body,
      };
    });
  }

  async claimDelivery(id: string, maxAttempts: number, staleSendingMs: number) {
    const { data: current, error: readErr } = await this.db
      .from("notification_deliveries")
      .select("attempts, status, updated_at")
      .eq("id", id)
      .single();
    if (readErr || !current) return false;
    const status = current.status as string;
    const attempts = current.attempts as number;
    const stale = status === "sending" && Date.parse(current.updated_at as string) < Date.now() - staleSendingMs;
    if (!(status === "pending" || status === "failed" || stale) || attempts >= maxAttempts) return false;
    // Compare-and-set on status, attempts and updated_at so two workers cannot both claim it.
    const { data, error } = await this.db
      .from("notification_deliveries")
      .update({ status: "sending", attempts: attempts + 1, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", status)
      .eq("attempts", attempts)
      .eq("updated_at", current.updated_at as string)
      .select("id");
    if (error) fail("claimDelivery", error);
    return (data?.length ?? 0) === 1;
  }

  async markDelivery(id: string, status: "sent" | "failed" | "skipped", err: string | null) {
    const { error } = await this.db
      .from("notification_deliveries")
      .update({
        status,
        last_error: err,
        sent_at: status === "sent" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) fail("markDelivery", error);
  }

  async getTelegramSettings(): Promise<TelegramSettings> {
    const { data, error } = await this.db
      .from("app_settings")
      .select("telegram_enabled, telegram_chat_id")
      .eq("singleton", true)
      .maybeSingle();
    if (error) fail("getTelegramSettings", error);
    return { enabled: Boolean(data?.telegram_enabled), chatId: (data?.telegram_chat_id as string | null) ?? null };
  }
}
