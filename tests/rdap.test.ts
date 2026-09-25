import { describe, expect, it } from "vitest";
import { parseBootstrap, snapshotBootstrap } from "@/lib/providers/rdap/bootstrap";
import { RdapProvider } from "@/lib/providers/rdap/provider";

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

  it("returns unknown (not unregistered) on timeouts, after a limited retry", async () => {
    const { fn, calls } = mockFetch(() => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const r = await provider(fn, 2).lookup("examplebrand.org", "org");
    expect(r.status).toBe("unknown");
    expect(r.error).toMatch(/timeout/);
    expect(calls).toHaveLength(2);
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
