import { beforeEach, describe, expect, it, vi } from "vitest";

// No request context in tests: provide an empty cookie store (= signed out).
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
  headers: async () => new Headers(),
}));

// `after` must never run monitoring work for rejected requests.
const afterSpy = vi.fn();
vi.mock("next/server", async (orig) => {
  const actual = await orig<typeof import("next/server")>();
  return { ...actual, after: (fn: unknown) => afterSpy(fn) };
});

import { isCronAuthorized } from "@/lib/cron-auth";

const SECRET = "test-cron-secret-0123456789";

beforeEach(() => {
  afterSpy.mockReset();
  process.env.CRON_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9"; // unreachable on purpose
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
});

describe("isCronAuthorized", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isCronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isCronAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isCronAuthorized(SECRET, SECRET)).toBe(false);
    expect(isCronAuthorized(null, SECRET)).toBe(false);
  });

  it("rejects everything when the secret is missing or too short", () => {
    expect(isCronAuthorized("Bearer ", "")).toBe(false);
    expect(isCronAuthorized("Bearer undefined", undefined)).toBe(false);
    expect(isCronAuthorized("Bearer short", "short")).toBe(false);
  });
});

describe("GET /api/cron/monitor", () => {
  it("rejects requests without the cron secret", async () => {
    const { GET } = await import("@/app/api/cron/monitor/route");
    const res = await GET(new Request("https://app.test/api/cron/monitor"));
    expect(res.status).toBe(401);
    expect(afterSpy).not.toHaveBeenCalled();
  });

  it("rejects requests with a wrong secret", async () => {
    const { GET } = await import("@/app/api/cron/monitor/route");
    const res = await GET(
      new Request("https://app.test/api/cron/monitor", { headers: { authorization: "Bearer wrong-secret-0000000" } }),
    );
    expect(res.status).toBe(401);
    expect(afterSpy).not.toHaveBeenCalled();
  });

  it("accepts the correct secret and schedules the run", async () => {
    const { GET } = await import("@/app/api/cron/monitor/route");
    const res = await GET(
      new Request("https://app.test/api/cron/monitor", { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(202);
    expect(afterSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses continuation chains beyond the limit", async () => {
    const { GET } = await import("@/app/api/cron/monitor/route");
    const res = await GET(
      new Request("https://app.test/api/cron/monitor?depth=99", { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(res.status).toBe(400);
    expect(afterSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/check", () => {
  it("rejects signed-out requests with 401 before doing any work", async () => {
    const { POST } = await import("@/app/api/check/route");
    const res = await POST(
      new Request("https://app.test/api/check", { method: "POST", body: JSON.stringify({ scope: "all" }) }),
    );
    expect(res.status).toBe(401);
    expect(afterSpy).not.toHaveBeenCalled();
  });
});
