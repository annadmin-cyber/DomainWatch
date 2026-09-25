import { randomUUID } from "node:crypto";
import type {
  MonitorRepository,
  PendingDelivery,
  RunStatus,
  RunSummary,
  RunTrigger,
  TelegramSettings,
} from "@/lib/monitor/repository";
import type { DomainState, DomainUpdate, NewEvent } from "@/lib/monitor/transition";
import type { LookupResult } from "@/lib/providers/types";

type Row = DomainState & Omit<Partial<DomainUpdate>, keyof DomainState> & { is_active: boolean; claimed_until: number | null; created: number };

/** In-memory MonitorRepository mirroring the database's unique constraints. */
export class MemoryRepository implements MonitorRepository {
  domains = new Map<string, Row>();
  runs = new Map<string, { trigger: RunTrigger; status: RunStatus; summary?: RunSummary }>();
  checks: { domainId: string; result: LookupResult; confirmation: boolean }[] = [];
  events = new Map<string, NewEvent & { id: string; domainId: string }>(); // by dedupe key
  notifications = new Map<string, { id: string; eventId: string; kind: string; title: string; body: string }>();
  deliveries = new Map<string, { id: string; notificationId: string; status: string; attempts: number; error: string | null }>();
  lock: { runId: string | null; until: number } = { runId: null, until: 0 };
  telegram: TelegramSettings = { enabled: false, chatId: null };
  clock: () => number = () => Date.now();

  addDomain(fqdn: string, extra: Partial<Row> = {}): string {
    const id = randomUUID();
    this.domains.set(id, {
      id,
      fqdn,
      suffix: fqdn.slice(fqdn.indexOf(".") + 1),
      is_mine: false,
      status: "not_checked",
      last_conclusive_status: null,
      last_conclusive_at: null,
      last_confirmed_unregistered_at: null,
      baseline_status: null,
      consecutive_failures: 0,
      is_active: true,
      claimed_until: null,
      created: this.domains.size,
      ...extra,
    });
    return id;
  }

  state(id: string): DomainState {
    const r = this.domains.get(id)!;
    return {
      id: r.id,
      fqdn: r.fqdn,
      suffix: r.suffix,
      is_mine: r.is_mine,
      status: r.status,
      last_conclusive_status: r.last_conclusive_status,
      last_conclusive_at: r.last_conclusive_at,
      last_confirmed_unregistered_at: r.last_confirmed_unregistered_at,
      baseline_status: r.baseline_status,
      consecutive_failures: r.consecutive_failures,
    };
  }

  row(id: string) {
    return this.domains.get(id)!;
  }

  async createRun(trigger: RunTrigger) {
    const id = randomUUID();
    this.runs.set(id, { trigger, status: "running" });
    return id;
  }
  async finishRun(runId: string, status: RunStatus, summary: RunSummary) {
    const r = this.runs.get(runId)!;
    r.status = status;
    r.summary = summary;
  }
  async acquireLock(runId: string, ttlSeconds: number) {
    const now = this.clock();
    if (this.lock.until < now || this.lock.runId === runId) {
      this.lock = { runId, until: now + ttlSeconds * 1000 };
      return true;
    }
    return false;
  }
  async releaseLock(runId: string) {
    if (this.lock.runId === runId) this.lock = { runId: null, until: 0 };
  }

  private claimable(r: Row) {
    return r.claimed_until === null || r.claimed_until < this.clock();
  }

  async claimDue(limit: number, dueBefore: Date, claimSeconds: number) {
    const due = [...this.domains.values()]
      .filter(
        (r) =>
          r.is_active &&
          this.claimable(r) &&
          (!r.last_checked_at || new Date(r.last_checked_at).getTime() < dueBefore.getTime()),
      )
      .sort((a, b) => (a.last_checked_at ?? "").localeCompare(b.last_checked_at ?? "") || a.created - b.created)
      .slice(0, limit);
    for (const r of due) r.claimed_until = this.clock() + claimSeconds * 1000;
    return due.map((r) => this.state(r.id));
  }
  async claimOne(id: string, claimSeconds: number) {
    const r = this.domains.get(id);
    if (!r || !this.claimable(r)) return null;
    r.claimed_until = this.clock() + claimSeconds * 1000;
    return this.state(id);
  }
  async releaseClaims(ids: string[]) {
    for (const id of ids) {
      const r = this.domains.get(id);
      if (r) r.claimed_until = null;
    }
  }
  async countDue(dueBefore: Date) {
    return [...this.domains.values()].filter(
      (r) => r.is_active && (!r.last_checked_at || new Date(r.last_checked_at).getTime() < dueBefore.getTime()),
    ).length;
  }
  async saveCheck(domainId: string, _runId: string | null, result: LookupResult, confirmation: boolean) {
    this.checks.push({ domainId, result, confirmation });
  }
  async applyUpdate(domainId: string, update: DomainUpdate) {
    const r = this.domains.get(domainId)!;
    Object.assign(r, update, { claimed_until: null });
  }
  async insertEvent(domainId: string, event: NewEvent) {
    if (this.events.has(event.dedupe_key)) return null;
    const id = randomUUID();
    this.events.set(event.dedupe_key, { ...event, id, domainId });
    return id;
  }
  async createNotification(eventId: string, kind: "alert" | "info", title: string, body: string) {
    if ([...this.notifications.values()].some((n) => n.eventId === eventId)) return null;
    const id = randomUUID();
    this.notifications.set(id, { id, eventId, kind, title, body });
    return id;
  }
  async queueDelivery(notificationId: string) {
    if ([...this.deliveries.values()].some((d) => d.notificationId === notificationId)) return;
    const id = randomUUID();
    this.deliveries.set(id, { id, notificationId, status: "pending", attempts: 0, error: null });
  }
  async listPendingDeliveries(limit: number, maxAttempts: number): Promise<PendingDelivery[]> {
    return [...this.deliveries.values()]
      .filter((d) => ["pending", "failed"].includes(d.status) && d.attempts < maxAttempts)
      .slice(0, limit)
      .map((d) => {
        const n = this.notifications.get(d.notificationId)!;
        return { id: d.id, notification_id: d.notificationId, attempts: d.attempts, title: n.title, body: n.body };
      });
  }
  async claimDelivery(id: string, maxAttempts: number) {
    const d = this.deliveries.get(id);
    if (!d || !["pending", "failed"].includes(d.status) || d.attempts >= maxAttempts) return false;
    d.status = "sending";
    d.attempts++;
    return true;
  }
  async markDelivery(id: string, status: "sent" | "failed" | "skipped", error: string | null) {
    const d = this.deliveries.get(id)!;
    d.status = status;
    d.error = error;
  }
  async getTelegramSettings() {
    return this.telegram;
  }
}
