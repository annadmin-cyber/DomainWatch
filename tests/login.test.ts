import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Login server action, rate limiter and the manual-check limiter, with
 * Supabase and Next's request APIs mocked. No network access.
 */
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }),
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

const afterSpy = vi.fn();
vi.mock("next/server", async (orig) => {
  const actual = await orig<typeof import("next/server")>();
  return { ...actual, after: (fn: unknown) => afterSpy(fn) };
});

const allowRequest = vi.fn();
vi.mock("@/lib/rate-limit", () => ({ allowRequest: (...args: unknown[]) => allowRequest(...args) }));

const signInWithPassword = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithPassword } }),
}));

const rpc = vi.fn();
const createAdminClient = vi.fn(() => ({ rpc }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminClient() }));

vi.mock("@/lib/auth", async (orig) => {
  const actual = await orig<typeof import("@/lib/auth")>();
  return { ...actual, requireOwner: async () => ({ userId: "u", email: null, supabase: {} }) };
});

import { signIn } from "@/app/login/actions";

const EMAIL = "owner@example.com";
const PASSWORD = "correct horse battery staple";

function form(email = EMAIL, password = PASSWORD) {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

function authError(status: number | undefined, code: string | undefined, message = "error") {
  return { data: {}, error: Object.assign(new Error(message), { name: "AuthApiError", status, code }) };
}

beforeEach(() => {
  vi.restoreAllMocks();
  allowRequest.mockReset().mockResolvedValue("allowed");
  signInWithPassword.mockReset();
  rpc.mockReset();
  createAdminClient.mockReset().mockImplementation(() => ({ rpc }));
  afterSpy.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.CRON_SECRET = "test-cron-secret-0123456789";
});

describe("signIn", () => {
  it("redirects to the dashboard on success", async () => {
    signInWithPassword.mockResolvedValue({ data: {}, error: null });
    await expect(signIn({ error: null }, form())).rejects.toThrow("REDIRECT /");
  });

  it("maps Supabase errors to specific Indonesian messages", async () => {
    const cases: [ReturnType<typeof authError>, RegExp][] = [
      [authError(400, "invalid_credentials"), /Email atau kata sandi salah/],
      [authError(400, undefined), /Email atau kata sandi salah/],
      [authError(400, "email_not_confirmed"), /belum dikonfirmasi.*Authentication > Users/],
      [authError(422, "email_provider_disabled"), /Sign In \/ Providers > Email.*Allow new users to sign up/],
      [authError(429, "over_request_rate_limit"), /Terlalu banyak percobaan/],
      [authError(0, undefined, "fetch failed"), /tidak bisa terhubung ke Supabase/],
      [authError(401, undefined, "Invalid API key"), /tidak bisa terhubung ke Supabase.*\(kode: 401\)$/],
      [authError(401, "invalid_api_key"), /\(kode: 401 invalid_api_key\)$/],
      [authError(500, "unexpected_failure"), /tidak bisa terhubung ke Supabase.*\(kode: 500 unexpected_failure\)$/],
    ];
    for (const [response, message] of cases) {
      signInWithPassword.mockResolvedValueOnce(response);
      expect((await signIn({ error: null }, form())).error).toMatch(message);
    }
  });

  it("logs unexpected errors without the email or password", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signInWithPassword.mockResolvedValue(authError(503, undefined, "Service Unavailable"));
    await signIn({ error: null }, form());
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("503");
    expect(logged).not.toContain(EMAIL);
    expect(logged).not.toContain(PASSWORD);
  });

  it("checks the IP limit first and does not touch the email bucket when the IP is blocked", async () => {
    allowRequest.mockResolvedValueOnce("limited");
    expect((await signIn({ error: null }, form())).error).toMatch(/Terlalu banyak percobaan/);
    expect(allowRequest).toHaveBeenCalledTimes(1);
    expect(allowRequest.mock.calls[0][0]).toBe("login:ip:203.0.113.7");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("blocks when the account limit is reached", async () => {
    allowRequest.mockResolvedValueOnce("allowed").mockResolvedValueOnce("limited");
    expect((await signIn({ error: null }, form())).error).toMatch(/Terlalu banyak percobaan/);
    expect(allowRequest.mock.calls[1][0]).toMatch(/^login:email:[0-9a-f]{32}$/);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("fails open when the rate limiter itself is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    allowRequest.mockResolvedValue("error");
    signInWithPassword.mockResolvedValue({ data: {}, error: null });
    await expect(signIn({ error: null }, form())).rejects.toThrow("REDIRECT /");
    expect(signInWithPassword).toHaveBeenCalledOnce();
  });

  it("sends the visitor to /setup when configuration is missing or invalid", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "abcd1234.supabase.co"; // no https://
    await expect(signIn({ error: null }, form())).rejects.toThrow("REDIRECT /setup");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcd1234.supabase.co";
    delete process.env.SUPABASE_SECRET_KEY;
    await expect(signIn({ error: null }, form())).rejects.toThrow("REDIRECT /setup");
    expect(allowRequest).not.toHaveBeenCalled();
  });
});

describe("allowRequest", () => {
  const load = async () =>
    (await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit")).allowRequest;

  it("distinguishes allowed, limited and a broken limiter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const allow = await load();
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await allow("k", 1, 60)).toBe("allowed");
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await allow("k", 1, 60)).toBe("limited");
    rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });
    expect(await allow("k", 1, 60)).toBe("error");
    createAdminClient.mockImplementationOnce(() => {
      throw new Error("Supabase server credentials are not configured");
    });
    expect(await allow("k", 1, 60)).toBe("error");
  });
});

describe("POST /api/check rate limit", () => {
  it("fails closed with 503 when the limiter is unavailable", async () => {
    allowRequest.mockResolvedValue("error");
    const { POST } = await import("@/app/api/check/route");
    const res = await POST(new Request("https://app.test/api/check", { method: "POST", body: JSON.stringify({ scope: "all" }) }));
    expect(res.status).toBe(503);
    expect(afterSpy).not.toHaveBeenCalled();
  });

  it("returns 429 when the limit is reached", async () => {
    allowRequest.mockResolvedValueOnce("allowed").mockResolvedValueOnce("limited");
    const { POST } = await import("@/app/api/check/route");
    const res = await POST(
      new Request("https://app.test/api/check", {
        method: "POST",
        body: JSON.stringify({ id: "11111111-1111-1111-1111-111111111111" }),
      }),
    );
    expect(res.status).toBe(429);
  });
});
