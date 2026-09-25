import type { LookupResult } from "@/lib/providers/types";
import type { DomainState, DomainUpdate, NewEvent } from "./transition";

export type RunTrigger = "cron" | "continuation" | "manual";
export type RunStatus = "running" | "success" | "partial" | "failed" | "skipped";

export type RunSummary = {
  checked_count: number;
  conclusive_count: number;
  error_count: number;
  remaining_count: number;
  events_count: number;
  message: string | null;
};

export type PendingDelivery = {
  id: string;
  notification_id: string;
  attempts: number;
  title: string;
  body: string;
};

export type TelegramSettings = {
  enabled: boolean;
  chatId: string | null;
};

/**
 * Persistence used by the monitor engine. Implemented with Supabase in
 * production and in memory for tests.
 */
export interface MonitorRepository {
  createRun(trigger: RunTrigger, chainId: string | null, depth: number): Promise<string>;
  finishRun(runId: string, status: RunStatus, summary: RunSummary): Promise<void>;
  acquireLock(runId: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(runId: string): Promise<void>;

  claimDue(limit: number, dueBefore: Date, claimSeconds: number): Promise<DomainState[]>;
  claimOne(id: string, claimSeconds: number): Promise<DomainState | null>;
  releaseClaims(ids: string[]): Promise<void>;
  countDue(dueBefore: Date): Promise<number>;

  saveCheck(domainId: string, runId: string | null, result: LookupResult, confirmation: boolean, at: Date): Promise<void>;
  applyUpdate(domainId: string, update: DomainUpdate): Promise<void>;

  /** Insert an event; returns null when an event with the same dedupe key exists. */
  insertEvent(domainId: string, event: NewEvent, detectedAt: Date): Promise<string | null>;
  /** Create the notification for an event (idempotent per event). */
  createNotification(eventId: string, kind: "alert" | "info", title: string, body: string): Promise<string | null>;
  /** Queue a delivery (idempotent per notification + channel). */
  queueDelivery(notificationId: string, channel: "telegram"): Promise<void>;

  listPendingDeliveries(limit: number, maxAttempts: number): Promise<PendingDelivery[]>;
  /** Atomically move a delivery to "sending"; false if another worker took it. */
  claimDelivery(id: string, maxAttempts: number): Promise<boolean>;
  markDelivery(id: string, status: "sent" | "failed" | "skipped", error: string | null): Promise<void>;

  getTelegramSettings(): Promise<TelegramSettings>;
}
