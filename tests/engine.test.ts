import { beforeEach, describe, expect, it } from "vitest";
import { checkDomain, deliverPending, runMonitor, type EngineDeps } from "@/lib/monitor/engine";
import { FixtureProvider } from "./helpers/fixture-provider";
import { MemoryRepository } from "./helpers/memory-repository";

const noSleep = async () => {};
let repo: MemoryRepository;
let provider: FixtureProvider;
let clock: number;
let deps: EngineDeps;

function advance(hours: number) {
  clock += hours * 60 * 60 * 1000;
}

beforeEach(() => {
  repo = new MemoryRepository();
  provider = new FixtureProvider();
  clock = Date.parse("2026-09-25T01:00:00Z");
  repo.clock = () => clock;
  deps = { repo, provider, sleep: noSleep, now: () => new Date(clock) };
});

const alerts = () => [...repo.events.values()].filter((e) => e.alert);

describe("baselines", () => {
  it("saves the first conclusive result as baseline without alerting", async () => {
    const reg = repo.addDomain("examplebrand.net");
    const free = repo.addDomain("examplebrand.org");
    provider.set("examplebrand.net", "registered");
    provider.set("examplebrand.org", "unregistered");

    const out = await runMonitor(deps, { trigger: "cron" });
    expect(out.status).toBe("success");
    expect(out.checked).toBe(2);

    expect(repo.row(reg)).toMatchObject({
      status: "registered",
      baseline_status: "registered",
      status_detail: "Sudah terdaftar saat pemantauan dimulai",
      registration_date: "2026-09-20T00:00:00.000Z",
    });
    expect(repo.row(free)).toMatchObject({ status: "unregistered", baseline_status: "unregistered" });
    expect(repo.row(free).last_confirmed_unregistered_at).toBe(new Date(clock).toISOString());
    expect(alerts()).toHaveLength(0);
    expect(repo.notifications.size).toBe(0);
  });

  it("existing registrations never trigger new-registration alerts on later checks", async () => {
    repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "registered");
    for (let day = 0; day < 3; day++) {
      await runMonitor(deps, { trigger: "cron" });
      advance(24);
    }
    expect(alerts()).toHaveLength(0);
  });

  it("does not create a baseline from an inconclusive result", async () => {
    const id = repo.addDomain("examplebrand.store");
    provider.set("examplebrand.store", "unknown");
    await runMonitor(deps, { trigger: "cron" });
    expect(repo.row(id).baseline_status).toBeNull();
    expect(repo.row(id).status).toBe("unknown");
  });
});

describe("change detection", () => {
  it("creates exactly one alert for a confirmed unregistered -> registered transition", async () => {
    const id = repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "unregistered");
    await runMonitor(deps, { trigger: "cron" });
    const unregisteredAt = repo.row(id).last_confirmed_unregistered_at;

    advance(24);
    provider.set("examplebrand.net", "registered");
    await runMonitor(deps, { trigger: "cron" });

    const a = alerts();
    expect(a).toHaveLength(1);
    expect(a[0].event_type).toBe("new_registration");
    expect(a[0].previous_confirmed_unregistered_at).toBe(unregisteredAt);
    expect(a[0].message).toContain("examplebrand.net sekarang terdaftar");
    expect(a[0].message).toContain("Sebelumnya dikonfirmasi belum terdaftar pada");
    expect(a[0].message).toContain("Perubahan terdeteksi pada");
    expect(repo.notifications.size).toBe(1);
    expect(repo.deliveries.size).toBe(1);
    // primary + confirmation lookup
    expect(repo.checks.filter((c) => c.confirmation)).toHaveLength(1);

    // Repeated checks stay registered and must not alert again.
    for (let i = 0; i < 3; i++) {
      advance(24);
      await runMonitor(deps, { trigger: "cron" });
    }
    expect(alerts()).toHaveLength(1);
    expect(repo.notifications.size).toBe(1);
  });

  it("is idempotent when the same transition is processed twice (e.g. retry after a crash)", async () => {
    const id = repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "unregistered");
    await runMonitor(deps, { trigger: "cron" });
    const before = repo.state(id);

    advance(24);
    provider.set("examplebrand.net", "registered");
    // Two workers processing the same stale state.
    await checkDomain(deps, before, null, 0);
    await checkDomain(deps, before, null, 0);
    expect(alerts()).toHaveLength(1);
    expect(repo.notifications.size).toBe(1);
    expect(repo.deliveries.size).toBe(1);
  });

  it("requires the confirmation lookup to agree before alerting", async () => {
    const id = repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "unregistered");
    await runMonitor(deps, { trigger: "cron" });

    advance(24);
    provider.queue("examplebrand.net", "registered", "unknown");
    await runMonitor(deps, { trigger: "cron" });
    expect(alerts()).toHaveLength(0);
    expect(repo.row(id).status).toBe("unknown");
    expect(repo.row(id).last_conclusive_status).toBe("unregistered");
  });

  it("provider errors never turn into unregistered and never erase the last confirmed state", async () => {
    const id = repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "registered");
    await runMonitor(deps, { trigger: "cron" });

    advance(24);
    provider.set("examplebrand.net", "unknown");
    const out = await runMonitor(deps, { trigger: "cron" });
    expect(out.errors).toBe(1);
    expect(repo.row(id)).toMatchObject({
      status: "unknown",
      last_conclusive_status: "registered",
      consecutive_failures: 1,
    });
    expect([...repo.events.values()].filter((e) => e.event_type === "became_unregistered")).toHaveLength(0);
  });

  it("uses 'newly detected' wording when checks between were inconclusive", async () => {
    repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "unregistered");
    await runMonitor(deps, { trigger: "cron" });
    advance(24);
    provider.set("examplebrand.net", "unknown");
    await runMonitor(deps, { trigger: "cron" });
    advance(24);
    provider.set("examplebrand.net", "registered");
    await runMonitor(deps, { trigger: "cron" });

    const a = alerts();
    expect(a).toHaveLength(1);
    expect(a[0].event_type).toBe("newly_detected_registered");
    expect(a[0].message).toContain("baru terdeteksi sebagai terdaftar");
    expect(a[0].message).not.toContain("sekarang terdaftar");
  });

  it("domains marked as mine do not produce third-party alerts", async () => {
    repo.addDomain("examplebrand.net", { is_mine: true });
    provider.set("examplebrand.net", "unregistered");
    await runMonitor(deps, { trigger: "cron" });
    advance(24);
    provider.set("examplebrand.net", "registered");
    await runMonitor(deps, { trigger: "cron" });
    expect(alerts()).toHaveLength(0);
    expect([...repo.events.values()].some((e) => e.event_type === "own_domain_change")).toBe(true);
    expect(repo.notifications.size).toBe(0);
  });

  it("unsupported extensions are recorded as unsupported, not as errors", async () => {
    const id = repo.addDomain("examplebrand.io");
    provider.set("examplebrand.io", "unsupported");
    const out = await runMonitor(deps, { trigger: "cron" });
    expect(out.errors).toBe(0);
    expect(repo.row(id).status).toBe("unsupported");
    expect(repo.row(id).baseline_status).toBeNull();
  });
});

describe("runs, locking and batching", () => {
  it("skips a run while another run holds the lock", async () => {
    repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "registered");
    await repo.acquireLock("other-run", 300);
    const out = await runMonitor(deps, { trigger: "cron" });
    expect(out.status).toBe("skipped");
    expect(provider.calls).toHaveLength(0);
  });

  it("stops at the time budget and reports remaining work for a continuation", async () => {
    for (let i = 0; i < 10; i++) {
      repo.addDomain(`brand${i}.net`);
      provider.set(`brand${i}.net`, "registered");
    }
    // Each lookup costs 10 simulated seconds; budget allows only a few.
    provider.lookup = (async function (this: FixtureProvider, fqdn: string) {
      clock += 10_000;
      return FixtureProvider.prototype.lookup.call(this, fqdn);
    }).bind(provider);

    const first = await runMonitor(deps, {
      trigger: "cron",
      budgetMs: 60_000,
      reserveMs: 20_000,
      concurrency: 1,
      batchSize: 3,
    });
    expect(first.status).toBe("partial");
    expect(first.checked).toBeGreaterThan(0);
    expect(first.remaining).toBe(10 - first.checked);
    // Nothing is left claimed, so the continuation can pick everything up.
    expect([...repo.domains.values()].every((r) => r.claimed_until === null)).toBe(true);

    const second = await runMonitor(deps, { trigger: "continuation", depth: 1 });
    expect(second.remaining).toBe(0);
    expect(first.checked + second.checked).toBe(10);
  });

  it("does not re-check domains checked recently unless forced", async () => {
    repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "registered");
    await runMonitor(deps, { trigger: "cron" });
    advance(1);
    const again = await runMonitor(deps, { trigger: "cron" });
    expect(again.checked).toBe(0);
    const forced = await runMonitor(deps, { trigger: "manual", forceAll: true });
    expect(forced.checked).toBe(1);
  });
});

describe("Telegram delivery", () => {
  function telegramFetch(ok = true) {
    const sent: { url: string; body: { chat_id: string; text: string } }[] = [];
    const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, description: "Bad Request: chat not found" }), {
        status: ok ? 200 : 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fn, sent };
  }

  async function createAlert() {
    repo.addDomain("examplebrand.net");
    provider.set("examplebrand.net", "unregistered");
    await runMonitor(deps, { trigger: "cron" });
    advance(24);
    provider.set("examplebrand.net", "registered");
  }

  it("sends each alert once when Telegram is configured", async () => {
    const tg = telegramFetch();
    repo.telegram = { enabled: true, chatId: "12345" };
    deps = { ...deps, telegramToken: "TEST-TOKEN", fetchImpl: tg.fn };
    await createAlert();
    await runMonitor(deps, { trigger: "cron" });
    await deliverPending(deps);
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0].url).toBe("https://api.telegram.org/botTEST-TOKEN/sendMessage");
    expect(tg.sent[0].body.chat_id).toBe("12345");
    expect(tg.sent[0].body.text).toContain("examplebrand.net sekarang terdaftar");
    expect([...repo.deliveries.values()][0].status).toBe("sent");
  });

  it("marks delivery skipped (and keeps the in-app alert) when Telegram is not configured", async () => {
    await createAlert();
    await runMonitor(deps, { trigger: "cron" });
    expect(repo.notifications.size).toBe(1);
    expect([...repo.deliveries.values()][0].status).toBe("skipped");
  });

  it("records failures and gives up after the attempt limit", async () => {
    const tg = telegramFetch(false);
    repo.telegram = { enabled: true, chatId: "999" };
    deps = { ...deps, telegramToken: "TEST-TOKEN", fetchImpl: tg.fn };
    await createAlert();
    await runMonitor(deps, { trigger: "cron" });
    await deliverPending(deps);
    await deliverPending(deps);
    await deliverPending(deps);
    const d = [...repo.deliveries.values()][0];
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(3);
    expect(d.error).toContain("chat not found");
    expect(tg.sent).toHaveLength(3);
  });
});
