import type { LookupProvider, LookupResult } from "@/lib/providers/types";
import { sendTelegramMessage } from "@/lib/notify/telegram";
import type { MonitorRepository, RunStatus, RunTrigger } from "./repository";
import { decideTransition, needsConfirmation, type DomainState, type DomainUpdate } from "./transition";

export const MONITOR_DEFAULTS = {
  /** Wall-clock budget for one invocation; Vercel Hobby allows 300 s. */
  budgetMs: 240_000,
  /** Stop claiming new work when less than this remains. */
  reserveMs: 30_000,
  concurrency: 4,
  batchSize: 20,
  /** A variant is due when its last check is older than this. */
  dueAgeMs: 20 * 60 * 60 * 1000,
  claimSeconds: 120,
  lockTtlSeconds: 320,
  confirmDelayMs: 3_000,
  maxDeliveryAttempts: 3,
};

export type EngineDeps = {
  repo: MonitorRepository;
  provider: LookupProvider;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  telegramToken?: string | null;
  fetchImpl?: typeof fetch;
};

export type RunOptions = {
  trigger: RunTrigger;
  chainId?: string | null;
  depth?: number;
  /** For manual "check everything": treat every active variant as due. */
  forceAll?: boolean;
} & Partial<typeof MONITOR_DEFAULTS>;

export type RunOutcome = {
  runId: string;
  status: RunStatus;
  checked: number;
  conclusive: number;
  errors: number;
  events: number;
  remaining: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type CheckOutcome = { status: DomainUpdate["status"]; event: boolean };

/** Check one variant, persist results and create events/notifications idempotently. */
export async function checkDomain(
  deps: EngineDeps,
  state: DomainState,
  runId: string | null,
  confirmDelayMs = MONITOR_DEFAULTS.confirmDelayMs,
): Promise<CheckOutcome> {
  const { repo, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const suffix = state.suffix;

  let primary: LookupResult;
  try {
    primary = await provider.lookup(state.fqdn, suffix);
  } catch (err) {
    primary = {
      status: "unknown",
      source: provider.name,
      error: `Kesalahan internal saat pengecekan: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
    };
  }
  await repo.saveCheck(state.id, runId, primary, false, now());

  let confirmation: LookupResult | undefined;
  if (needsConfirmation(state, primary)) {
    await sleep(confirmDelayMs);
    try {
      confirmation = await provider.lookup(state.fqdn, suffix);
    } catch {
      confirmation = { status: "unknown", source: provider.name, error: "Pemeriksaan ulang gagal.", durationMs: 0 };
    }
    await repo.saveCheck(state.id, runId, confirmation, true, now());
  }

  const at = now();
  const decision = decideTransition(state, primary, confirmation, at);

  // Event and notification are written before the state update: if anything
  // fails midway, the next check reproduces the same dedupe key instead of
  // silently losing (or duplicating) the alert.
  let eventCreated = false;
  if (decision.event) {
    const eventId = await repo.insertEvent(state.id, decision.event, at);
    eventCreated = eventId !== null;
    if (eventId && decision.event.notify) {
      const notificationId = await repo.createNotification(
        eventId,
        decision.event.alert ? "alert" : "info",
        decision.event.title,
        decision.event.message,
      );
      if (notificationId && decision.event.alert) {
        await repo.queueDelivery(notificationId, "telegram");
      }
    }
  }
  await repo.applyUpdate(state.id, decision.update);
  return { status: decision.update.status, event: eventCreated };
}

/** Deliver queued Telegram notifications (at most once per notification). */
export async function deliverPending(deps: EngineDeps, maxAttempts = MONITOR_DEFAULTS.maxDeliveryAttempts) {
  const { repo } = deps;
  const pending = await repo.listPendingDeliveries(50, maxAttempts);
  if (pending.length === 0) return { sent: 0, failed: 0, skipped: 0 };
  const settings = await repo.getTelegramSettings();
  const token = deps.telegramToken ?? null;
  let sent = 0,
    failed = 0,
    skipped = 0;
  for (const d of pending) {
    if (!(await repo.claimDelivery(d.id, maxAttempts))) continue;
    if (!settings.enabled || !settings.chatId || !token) {
      await repo.markDelivery(d.id, "skipped", "Telegram belum diaktifkan atau belum dikonfigurasi.");
      skipped++;
      continue;
    }
    const res = await sendTelegramMessage(token, settings.chatId, `🔔 ${d.title}\n\n${d.body}`, deps.fetchImpl);
    if (res.ok) {
      await repo.markDelivery(d.id, "sent", null);
      sent++;
    } else {
      await repo.markDelivery(d.id, "failed", res.error);
      failed++;
    }
  }
  return { sent, failed, skipped };
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * One monitoring invocation. Holds a global lock so runs never overlap,
 * processes due variants in claimed batches until the time budget is spent,
 * and reports how many due variants remain for a continuation run.
 */
export async function runMonitor(deps: EngineDeps, opts: RunOptions): Promise<RunOutcome> {
  const cfg = { ...MONITOR_DEFAULTS, ...opts };
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const started = now();
  const runId = await repo.createRun(opts.trigger, opts.chainId ?? null, opts.depth ?? 0);

  if (!(await repo.acquireLock(runId, cfg.lockTtlSeconds))) {
    await repo.finishRun(runId, "skipped", {
      checked_count: 0,
      conclusive_count: 0,
      error_count: 0,
      remaining_count: 0,
      events_count: 0,
      message: "Pemantauan lain sedang berjalan, jadi proses ini dilewati.",
    });
    return { runId, status: "skipped", checked: 0, conclusive: 0, errors: 0, events: 0, remaining: 0 };
  }

  const dueBefore = opts.forceAll ? started : new Date(started.getTime() - cfg.dueAgeMs);
  const deadline = started.getTime() + cfg.budgetMs;
  let checked = 0,
    conclusive = 0,
    errors = 0,
    events = 0;
  let fatal: string | null = null;

  try {
    while (deadline - now().getTime() > cfg.reserveMs) {
      const batch = await repo.claimDue(cfg.batchSize, dueBefore, cfg.claimSeconds);
      if (batch.length === 0) break;
      const unstarted = new Set(batch.map((d) => d.id));
      await pool(batch, cfg.concurrency, async (state) => {
        if (deadline - now().getTime() <= cfg.reserveMs) return;
        unstarted.delete(state.id);
        try {
          const r = await checkDomain(deps, state, runId, cfg.confirmDelayMs);
          checked++;
          if (r.status === "registered" || r.status === "unregistered") conclusive++;
          else if (r.status === "unknown") errors++;
          if (r.event) events++;
        } catch (err) {
          errors++;
          console.error(`Check failed for ${state.fqdn}:`, err);
          await repo.releaseClaims([state.id]).catch(() => {});
        }
      });
      if (unstarted.size > 0) await repo.releaseClaims([...unstarted]);
    }
    await deliverPending(deps, cfg.maxDeliveryAttempts);
  } catch (err) {
    fatal = err instanceof Error ? err.message : String(err);
    console.error("Monitor run failed:", err);
  }

  let remaining = 0;
  try {
    remaining = await repo.countDue(dueBefore);
  } catch {
    remaining = -1;
  }

  // "errors" counts checks that ended as unknown (provider failures, timeouts).
  const status: RunStatus = fatal ? "failed" : remaining !== 0 ? "partial" : "success";
  const message = fatal
    ? `Proses gagal: ${fatal}`
    : remaining > 0
      ? `${remaining} domain belum sempat dicek dalam batas waktu; akan dilanjutkan otomatis.`
      : null;
  await repo.finishRun(runId, status, {
    checked_count: checked,
    conclusive_count: conclusive,
    error_count: errors,
    remaining_count: Math.max(remaining, 0),
    events_count: events,
    message,
  });
  await repo.releaseLock(runId);
  return { runId, status, checked, conclusive, errors, events, remaining: Math.max(remaining, 0) };
}
