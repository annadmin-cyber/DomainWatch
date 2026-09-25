import type { LookupProvider, LookupResult } from "@/lib/providers/types";
import { sendTelegramMessage } from "@/lib/notify/telegram";
import type { MonitorRepository, RunStatus, RunTrigger } from "./repository";
import { decideTransition, needsConfirmation, type DomainState, type DomainUpdate } from "./transition";

export const MONITOR_DEFAULTS = {
  /** No new check starts after this point of an invocation. */
  budgetMs: 200_000,
  /** Stop claiming new batches when less than this remains of budgetMs. */
  reserveMs: 10_000,
  /**
   * Hard limit for any registry request, including retries and confirmation
   * lookups of checks already in progress. Leaves time to save results,
   * deliver alerts and close the run before Vercel Hobby's 300 s limit.
   */
  hardLimitMs: 250_000,
  concurrency: 4,
  batchSize: 20,
  /**
   * A variant is due when its last check is older than this. Short enough that
   * a manual check during the day never makes the next daily run skip it, long
   * enough that continuation runs of the same day do not re-check it.
   */
  dueAgeMs: 3 * 60 * 60 * 1000,
  /** Covers a whole invocation, so claims never expire while a run is alive. */
  claimSeconds: 300,
  lockTtlSeconds: 320,
  confirmDelayMs: 3_000,
  maxDeliveryAttempts: 3,
  /** A delivery stuck in "sending" this long is assumed dead and retried. */
  staleSendingMs: 10 * 60 * 1000,
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
  /** Whether the caller will start a continuation run for remaining work. */
  willContinue?: boolean;
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

type CheckOutcome = { status: DomainUpdate["status"]; event: boolean; deferred?: boolean };

/** Check one variant, persist results and create events/notifications idempotently. */
export async function checkDomain(
  deps: EngineDeps,
  state: DomainState,
  runId: string | null,
  options: { confirmDelayMs?: number; deadline?: number } = {},
): Promise<CheckOutcome> {
  const { repo, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const confirmDelayMs = options.confirmDelayMs ?? MONITOR_DEFAULTS.confirmDelayMs;
  const deadline = options.deadline;
  const suffix = state.suffix;

  let primary: LookupResult;
  try {
    primary = await provider.lookup(state.fqdn, suffix, { deadline });
  } catch (err) {
    primary = {
      status: "unknown",
      source: provider.name,
      error: `Kesalahan internal saat pengecekan: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
    };
  }
  // Out of time before any request was sent: record nothing, so the domain
  // stays due and a continuation run checks it.
  if (primary.deferred) return { status: state.status, event: false, deferred: true };
  await repo.saveCheck(state.id, runId, primary, false, now());

  let confirmation: LookupResult | undefined;
  if (needsConfirmation(state, primary)) {
    // Without enough time for a proper second lookup the change stays
    // unconfirmed ("unknown") and is re-checked by the next run.
    const timeLeft = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now().getTime();
    if (timeLeft > confirmDelayMs + 5_000) {
      await sleep(confirmDelayMs);
      try {
        confirmation = await provider.lookup(state.fqdn, suffix, { deadline });
      } catch {
        confirmation = { status: "unknown", source: provider.name, error: "Pemeriksaan ulang gagal.", durationMs: 0 };
      }
      await repo.saveCheck(state.id, runId, confirmation, true, now());
    }
  }

  const at = now();
  const decision = decideTransition(state, primary, confirmation, at);

  // Event, notification and delivery are written before the state update and
  // each step is idempotent. If anything fails midway, the domain keeps its
  // old state, the next check produces the same dedupe key, and the chain is
  // completed without creating duplicates.
  let eventCreated = false;
  if (decision.event) {
    const { id: eventId, created } = await repo.insertEvent(state.id, decision.event, at);
    eventCreated = created;
    if (decision.event.notify) {
      const notificationId = await repo.createNotification(
        eventId,
        decision.event.alert ? "alert" : "info",
        decision.event.title,
        decision.event.message,
      );
      if (decision.event.alert) await repo.queueDelivery(notificationId, "telegram");
    }
  }
  await repo.applyUpdate(state.id, decision.update);
  return { status: decision.update.status, event: eventCreated };
}

/**
 * Deliver queued Telegram notifications. Each delivery is claimed atomically
 * before sending; one stuck in "sending" (worker died) is retried after
 * staleSendingMs, within the attempt limit.
 */
export async function deliverPending(
  deps: EngineDeps,
  options: { maxAttempts?: number; staleSendingMs?: number; deadline?: number } = {},
) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? MONITOR_DEFAULTS.maxDeliveryAttempts;
  const staleSendingMs = options.staleSendingMs ?? MONITOR_DEFAULTS.staleSendingMs;
  const pending = await repo.listPendingDeliveries(50, maxAttempts, staleSendingMs);
  if (pending.length === 0) return { sent: 0, failed: 0, skipped: 0 };
  const settings = await repo.getTelegramSettings();
  const token = deps.telegramToken ?? null;
  let sent = 0,
    failed = 0,
    skipped = 0;
  for (const d of pending) {
    // Leave the rest for the next run rather than risk being killed mid-send.
    if (options.deadline !== undefined && options.deadline - now().getTime() < 15_000) break;
    if (!(await repo.claimDelivery(d.id, maxAttempts, staleSendingMs))) continue;
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
  const stopStarting = started.getTime() + cfg.budgetMs;
  const hardDeadline = started.getTime() + cfg.hardLimitMs;
  let checked = 0,
    conclusive = 0,
    errors = 0,
    events = 0;
  let fatal: string | null = null;
  let remaining = 0;
  // Set when a lookup could not start before the hard deadline: stop claiming.
  let outOfTime = false;

  try {
    try {
      while (!outOfTime && stopStarting - now().getTime() > cfg.reserveMs) {
        const batch = await repo.claimDue(cfg.batchSize, dueBefore, cfg.claimSeconds);
        if (batch.length === 0) break;
        // Claims of variants not checked in this run are released right away.
        const unstarted = new Set(batch.map((d) => d.id));
        await pool(batch, cfg.concurrency, async (state) => {
          if (now().getTime() >= stopStarting) return;
          unstarted.delete(state.id);
          try {
            const r = await checkDomain(deps, state, runId, {
              confirmDelayMs: cfg.confirmDelayMs,
              deadline: hardDeadline,
            });
            if (r.deferred) {
              outOfTime = true;
              unstarted.add(state.id);
              return;
            }
            checked++;
            if (r.status === "registered" || r.status === "unregistered") conclusive++;
            else if (r.status === "unknown") errors++;
            if (r.event) events++;
          } catch (err) {
            // The claim is kept until it expires so this run does not retry
            // the same failing row in a loop; the next run picks it up.
            errors++;
            console.error(`Check failed for ${state.fqdn}:`, err);
          }
        });
        if (unstarted.size > 0) await repo.releaseClaims([...unstarted]);
      }
      await deliverPending(deps, {
        maxAttempts: cfg.maxDeliveryAttempts,
        staleSendingMs: cfg.staleSendingMs,
        deadline: started.getTime() + 285_000,
      });
    } catch (err) {
      fatal = err instanceof Error ? err.message : String(err);
      console.error("Monitor run failed:", err);
    }

    try {
      remaining = await repo.countDue(dueBefore);
    } catch {
      remaining = -1;
    }
  } finally {
    // "errors" counts checks that ended as unknown (provider failures, timeouts).
    const status: RunStatus = fatal ? "failed" : remaining !== 0 ? "partial" : "success";
    const message = fatal
      ? `Proses gagal: ${fatal}`
      : remaining > 0
        ? opts.willContinue
          ? `${remaining} domain belum sempat dicek dalam batas waktu; dilanjutkan otomatis oleh proses lanjutan.`
          : `${remaining} domain belum sempat dicek dalam batas waktu; akan dicek pada jadwal berikutnya.`
        : null;
    await repo
      .finishRun(runId, status, {
        checked_count: checked,
        conclusive_count: conclusive,
        error_count: errors,
        remaining_count: Math.max(remaining, 0),
        events_count: events,
        message,
      })
      .catch((err) => console.error("finishRun failed:", err));
    await repo.releaseLock(runId).catch((err) => console.error("releaseLock failed:", err));
  }
  const status: RunStatus = fatal ? "failed" : remaining !== 0 ? "partial" : "success";
  return { runId, status, checked, conclusive, errors, events, remaining: Math.max(remaining, 0) };
}
