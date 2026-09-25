import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IANA_BOOTSTRAP_URL,
  loadBootstrap,
  parseBootstrap,
  resetBootstrapCache,
  snapshotBootstrap,
} from "@/lib/providers/rdap/bootstrap";
import { parseRetryAfter, RdapProvider } from "@/lib/providers/rdap/provider";

const bootstrap = snapshotBootstrap();
const noSleep = async () => {};

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fn, calls };
}

function json(status: number, body: unknown, contentType = "application/rdap+json") {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

function provider(fetchImpl: typeof fetch, maxAttempts = 2) {
  return new RdapProvider({ fetchImpl, bootstrap, sleep: noSleep, perHostIntervalMs: 0, maxAttempts });
}

describe("RDAP provider", () => {
  it("reports registered with the registration date from RDAP events", async () => {
    const { fn, calls } = mockFetch(() =>
      json(200, {
        objectClassName: "domain",
        ldhName: "EXAMPLEBRAND.COM",
        events: [{ eventAction: "registration", eventDate: "2001-02-03T04:05:06Z" }],
      }),
    );
    const r = await provider(fn).lookup("examplebrand.com", "com");
    expect(r.status).toBe("registered");
    expect(r.registrationDate).toBe("2001-02-03T04:05:06.000Z");
    expect(r.source).toBe("RDAP (rdap.verisign.com)");
    expect(calls[0]).toBe("https://rdap.verisign.com/com/v1/domain/examplebrand.com");
  });

  it("queries the .id registry for .co.id names", async () => {
    const { fn, calls } = mockFetch(() => json(404, { errorCode: 404, title: "Not Found" }));
    const r = await provider(fn).lookup("examplebrand.co.id", "co.id");
    expect(r.status).toBe("unregistered");
    expect(calls[0]).toBe("https://rdap.pandi.id/rdap/domain/examplebrand.co.id");
  });

  it("treats an RDAP 404 (JSON or empty body) as unregistered", async () => {
    const empty = mockFetch(() => new Response(null, { status: 404 }));
    expect((await provider(empty.fn).lookup("examplebrand.net", "net")).status).toBe("unregistered");
  });

  it("never treats an HTML 404 as unregistered", async () => {
    const { fn } = mockFetch(() => new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } }));
    expect((await provider(fn).lookup("examplebrand.net", "net")).status).toBe("unknown");
  });

  it("only accepts a 404 that looks like an RDAP answer", async () => {
    const cases: [Response, string][] = [
      [new Response("404 page not found", { status: 404, headers: { "content-type": "text/plain" } }), "unknown"],
      [json(404, { message: "Not Found" }, "application/json"), "unknown"],
      [json(404, { errorCode: 404, title: "Not Found" }, "application/json"), "unregistered"],
      [json(404, { rdapConformance: ["rdap_level_0"] }, "application/json"), "unregistered"],
      [json(404, {}), "unregistered"],
    ];
    for (const [res, expected] of cases) {
      const { fn } = mockFetch(() => res);
      expect((await provider(fn).lookup("examplebrand.net", "net")).status).toBe(expected);
    }
  });

  it("treats a response body that times out as a timeout, not as invalid JSON", async () => {
    const stalled = () => {
      const body = new ReadableStream({
        start(controller) {
          const err = new Error("body timed out");
          err.name = "TimeoutError";
          controller.error(err);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/rdap+json" } });
    };
    const { fn, calls } = mockFetch(stalled);
    const r = await provider(fn).lookup("examplebrand.com", "com");
    expect(r.status).toBe("unknown");
    expect(r.error).toMatch(/timeout/);
    expect(calls).toHaveLength(1);
  });

  it("returns unknown (not unregistered) on timeouts, without retrying the timeout", async () => {
    const { fn, calls } = mockFetch(() => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const r = await provider(fn, 2).lookup("examplebrand.org", "org");
    expect(r.status).toBe("unknown");
    expect(r.error).toMatch(/timeout/);
    expect(calls).toHaveLength(1);
  });

  it("skips a registry for the rest of the run after repeated failures (circuit breaker)", async () => {
    const { fn, calls } = mockFetch(() => new Response("down", { status: 503 }));
    const p = provider(fn, 1);
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect((await p.lookup(`${name}.org`, "org")).status).toBe("unknown");
    }
    expect(calls).toHaveLength(3);
    // Other registries are unaffected.
    const other = await p.lookup("a.net", "net");
    expect(other.status).toBe("unknown");
    expect(calls).toHaveLength(4);
  });

  it("stops before the deadline instead of starting a request", async () => {
    const { fn, calls } = mockFetch(() => json(404, {}));
    const r = await provider(fn).lookup("examplebrand.org", "org", { deadline: Date.now() + 500 });
    expect(r.status).toBe("unknown");
    expect(r.deferred).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns unknown on rate limiting and server errors", async () => {
    const limited = mockFetch(() => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    expect((await provider(limited.fn).lookup("examplebrand.xyz", "xyz")).status).toBe("unknown");
    expect(limited.calls).toHaveLength(2);

    const broken = mockFetch(() => new Response("oops", { status: 503 }));
    expect((await provider(broken.fn).lookup("examplebrand.xyz", "xyz")).status).toBe("unknown");

    const network = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect((await provider(network.fn).lookup("examplebrand.xyz", "xyz")).status).toBe("unknown");
  });

  it("applies Retry-After to the whole registry host", async () => {
    const { fn, calls } = mockFetch(() => new Response("", { status: 429, headers: { "retry-after": "60" } }));
    const p = provider(fn);
    expect((await p.lookup("a.com", "com")).status).toBe("unknown");
    const next = await p.lookup("b.net", "net"); // same host: rdap.verisign.com
    expect(next.status).toBe("unknown");
    expect(next.error).toMatch(/rate limit/);
    expect(calls).toHaveLength(1);
  });

  it("understands Retry-After as seconds or as an HTTP date", async () => {
    const now = Date.parse("2026-09-25T00:00:00Z");
    expect(parseRetryAfter("5", now)).toBe(5_000);
    expect(parseRetryAfter("Fri, 25 Sep 2026 00:00:08 GMT", now)).toBe(8_000);
    expect(parseRetryAfter("Thu, 24 Sep 2026 23:59:00 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();

    const sleeps: number[] = [];
    const date = new Date(Date.now() + 4_000).toUTCString();
    const limited = mockFetch(() => new Response("", { status: 429, headers: { "retry-after": date } }));
    const p = new RdapProvider({
      fetchImpl: limited.fn,
      bootstrap,
      perHostIntervalMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await p.lookup("examplebrand.xyz", "xyz");
    expect(limited.calls).toHaveLength(2);
    const waited = Math.max(...sleeps);
    expect(waited).toBeGreaterThan(2_000);
    expect(waited).toBeLessThanOrEqual(4_000);
  });

  it("does not wait for long Retry-After values", async () => {
    const limited = mockFetch(() => new Response("", { status: 429, headers: { "retry-after": "3600" } }));
    const r = await provider(limited.fn, 3).lookup("examplebrand.xyz", "xyz");
    expect(r.status).toBe("unknown");
    expect(limited.calls).toHaveLength(1);
  });

  it("returns unknown for invalid or mismatching responses", async () => {
    const bad = mockFetch(() => new Response("not json", { status: 200, headers: { "content-type": "application/rdap+json" } }));
    expect((await provider(bad.fn).lookup("examplebrand.app", "app")).status).toBe("unknown");

    const other = mockFetch(() => json(200, { objectClassName: "domain", ldhName: "someoneelse.app" }));
    expect((await provider(other.fn).lookup("examplebrand.app", "app")).status).toBe("unknown");

    const entity = mockFetch(() => json(200, { objectClassName: "entity" }));
    expect((await provider(entity.fn).lookup("examplebrand.app", "app")).status).toBe("unknown");

    const teapot = mockFetch(() => json(418, {}));
    expect((await provider(teapot.fn).lookup("examplebrand.app", "app")).status).toBe("unknown");
  });

  it("reports extensions without an RDAP server as unsupported, without any request", async () => {
    const { fn, calls } = mockFetch(() => json(200, {}));
    const p = provider(fn);
    expect((await p.lookup("examplebrand.co", "co")).status).toBe("unsupported");
    expect((await p.lookup("examplebrand.io", "io")).status).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });
});

describe("loadBootstrap", () => {
  afterEach(() => {
    resetBootstrapCache();
    vi.useRealTimers();
  });

  const liveDoc = { services: [[["com"], ["https://rdap.verisign.com/com/v1/"]], [["asia"], ["https://rdap.example.asia/"]]] };

  it("keeps the last live list when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ok = mockFetch(() => json(200, liveDoc, "application/json"));
    expect((await loadBootstrap(ok.fn)).map.has("asia")).toBe(true);

    vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000); // cache expired
    const down = mockFetch(() => new Response("", { status: 503 }));
    const after = await loadBootstrap(down.fn);
    expect(down.calls).toEqual([IANA_BOOTSTRAP_URL]);
    expect(after.live).toBe(true);
    expect(after.map.has("asia")).toBe(true);
  });

  it("shares one request between parallel callers", async () => {
    const { fn, calls } = mockFetch(() => json(200, liveDoc, "application/json"));
    await Promise.all([loadBootstrap(fn), loadBootstrap(fn), loadBootstrap(fn)]);
    expect(calls).toHaveLength(1);
  });

  it("reports unknown, not unsupported, for TLDs missing from the fallback snapshot", async () => {
    const { fn, calls } = mockFetch((url) =>
      url === IANA_BOOTSTRAP_URL ? new Response("", { status: 503 }) : json(404, {}),
    );
    const p = new RdapProvider({ fetchImpl: fn, sleep: noSleep, perHostIntervalMs: 0 });
    const r = await p.lookup("examplebrand.asia", "asia");
    expect(r.status).toBe("unknown");
    expect(calls).toEqual([IANA_BOOTSTRAP_URL]);
    expect((await p.lookup("examplebrand.com", "com")).status).toBe("unregistered");
  });
});

describe("parseBootstrap", () => {
  it("maps TLDs to https base URLs with trailing slashes", () => {
    const map = parseBootstrap({
      services: [
        [["com", "net"], ["http://x.example/rdap", "https://x.example/rdap"]],
        [["id"], ["https://rdap.pandi.id/rdap/"]],
      ],
    });
    expect(map.get("com")).toEqual(["https://x.example/rdap/", "http://x.example/rdap/"]);
    expect(map.get("id")).toEqual(["https://rdap.pandi.id/rdap/"]);
  });

  it("rejects malformed documents", () => {
    expect(() => parseBootstrap({})).toThrow();
    expect(() => parseBootstrap({ services: [] })).toThrow();
  });
});
