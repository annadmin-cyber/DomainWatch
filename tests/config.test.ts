import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appBaseUrl, configStatus, missingRequiredConfig, publicSupabaseConfig } from "@/lib/env";
import { monitoringHealth, type RunRow } from "@/lib/health";
import { triggerContinuation } from "@/lib/monitor/runtime";
import { PAGE_SIZE, selectAll } from "@/lib/supabase/select-all";

const createServerClient = vi.fn();
vi.mock("@supabase/ssr", () => ({ createServerClient: (...args: unknown[]) => createServerClient(...args) }));

import { updateSession } from "@/lib/supabase/proxy";

const ENV_KEYS = [
  "APP_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "CRON_SECRET",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("appBaseUrl", () => {
  it("adds https:// and strips trailing slashes", () => {
    process.env.APP_URL = "domainwatch.vercel.app/";
    expect(appBaseUrl()).toBe("https://domainwatch.vercel.app");
    process.env.APP_URL = " https://www.example.com/// ";
    expect(appBaseUrl()).toBe("https://www.example.com");
    process.env.APP_URL = "http://localhost:3000/";
    expect(appBaseUrl()).toBe("http://localhost:3000");
  });

  it("falls back to Vercel's production URL when APP_URL is invalid or empty", () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "domainwatch.vercel.app";
    process.env.APP_URL = "https://exa mple.com";
    expect(appBaseUrl()).toBe("https://domainwatch.vercel.app");
    process.env.APP_URL = "ftp://example.com";
    expect(appBaseUrl()).toBe("https://domainwatch.vercel.app");
    delete process.env.APP_URL;
    expect(appBaseUrl()).toBe("https://domainwatch.vercel.app");
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(appBaseUrl()).toBeNull();
  });
});

describe("publicSupabaseConfig", () => {
  it("treats a Supabase URL that is not an http(s) URL as missing", () => {
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "abcd1234.supabase.co";
    expect(publicSupabaseConfig()).toBeNull();
    expect(configStatus().find((c) => c.name === "NEXT_PUBLIC_SUPABASE_URL")).toMatchObject({ ok: false, invalid: true });
    expect(missingRequiredConfig()).toContain("NEXT_PUBLIC_SUPABASE_URL");

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
    expect(publicSupabaseConfig()).toEqual({ url: "https://abcd1234.supabase.co", key: "sb_publishable_x" });
    expect(missingRequiredConfig()).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
  });
});

describe("triggerContinuation", () => {
  function stubFetch(res: Response) {
    const fn = vi.fn<typeof fetch>(async () => res);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  beforeEach(() => {
    process.env.APP_URL = "https://domainwatch.example.com";
    process.env.CRON_SECRET = "test-cron-secret-0123456789";
  });

  it("does not follow redirects and treats them as a failure", async () => {
    const fn = stubFetch(new Response(null, { status: 308, headers: { location: "https://www.domainwatch.example.com/" } }));
    expect(await triggerContinuation("chain", 1)).toBe(false);
    expect(fn.mock.calls[0][1]?.redirect).toBe("manual");
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain("https://www.domainwatch.example.com/");
  });

  it("succeeds only on a 2xx answer", async () => {
    stubFetch(new Response(null, { status: 202 }));
    expect(await triggerContinuation("chain", 1)).toBe(true);
    stubFetch(new Response(null, { status: 401 }));
    expect(await triggerContinuation("chain", 1)).toBe(false);
  });
});

describe("proxy updateSession", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_x";
    createServerClient.mockReset().mockImplementation(() => {
      throw new Error("Invalid supabaseUrl");
    });
  });

  it("treats a Supabase failure as signed out instead of crashing", async () => {
    const page = await updateSession(new NextRequest("https://app.test/domains"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://app.test/login");

    const login = await updateSession(new NextRequest("https://app.test/login"));
    expect(login.headers.get("location")).toBeNull();
    const api = await updateSession(new NextRequest("https://app.test/api/cron/monitor"));
    expect(api.headers.get("location")).toBeNull();
  });

  it("sends visitors to /setup when the Supabase URL is invalid", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "abcd1234.supabase.co";
    const res = await updateSession(new NextRequest("https://app.test/"));
    expect(res.headers.get("location")).toBe("https://app.test/setup");
    expect(createServerClient).not.toHaveBeenCalled();
  });
});

describe("selectAll", () => {
  it("reads past the Data API row cap in ordered pages", async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => i);
    const ranges: [number, number][] = [];
    const res = await selectAll<number>(async (from, to) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1), error: null };
    });
    expect(res.data).toHaveLength(2_500);
    expect(ranges).toEqual([
      [0, PAGE_SIZE - 1],
      [PAGE_SIZE, 2 * PAGE_SIZE - 1],
      [2 * PAGE_SIZE, 3 * PAGE_SIZE - 1],
    ]);
  });

  it("reports a failed page instead of returning a silent partial list", async () => {
    const res = await selectAll<number>(async (from) =>
      from === 0 ? { data: Array(PAGE_SIZE).fill(1), error: null } : { data: null, error: { message: "timeout" } },
    );
    expect(res.error?.message).toBe("timeout");
  });
});

describe("monitoringHealth", () => {
  const now = new Date("2026-09-25T03:00:00Z");
  const run = {
    id: "r",
    trigger: "cron",
    status: "success",
    started_at: "2026-09-25T01:05:00Z",
    finished_at: "2026-09-25T01:07:00Z",
    checked_count: 3,
    conclusive_count: 0,
    error_count: 3,
    remaining_count: 0,
    events_count: 0,
    message: null,
  } satisfies RunRow;

  it("is green only when every active variant has a recent conclusive result", () => {
    expect(monitoringHealth([run], { overdue: 0, inconclusive: 0 }, now).tone).toBe("success");
    const h = monitoringHealth([run], { overdue: 0, inconclusive: 3 }, now);
    expect(h.tone).toBe("warning");
    expect(h.title).toMatch(/3 varian belum mendapat hasil pasti/);
    expect(monitoringHealth([run], { overdue: 2, inconclusive: 3 }, now).title).toMatch(/2 varian belum dicek/);
  });
});
