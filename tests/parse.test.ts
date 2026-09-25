import { describe, expect, it } from "vitest";
import { buildVariant, parseDomainInput } from "@/lib/domains/parse";
import { tldOf } from "@/lib/domains/extensions";

describe("parseDomainInput", () => {
  it("recognises multi-part suffixes such as .co.id", () => {
    expect(parseDomainInput("examplebrand.co.id")).toEqual({
      ok: true,
      value: { domain: "examplebrand.co.id", label: "examplebrand", suffix: "co.id" },
    });
  });

  it("normalises case, scheme, path and a leading www", () => {
    const r = parseDomainInput("  HTTPS://www.ExampleBrand.COM/path?x=1 ");
    expect(r).toEqual({ ok: true, value: { domain: "examplebrand.com", label: "examplebrand", suffix: "com" } });
  });

  it("rejects subdomains, IPs, bare words and invalid characters", () => {
    expect(parseDomainInput("shop.examplebrand.com").ok).toBe(false);
    expect(parseDomainInput("192.168.1.1").ok).toBe(false);
    expect(parseDomainInput("examplebrand").ok).toBe(false);
    expect(parseDomainInput("exa mple.com").ok).toBe(false);
    expect(parseDomainInput("").ok).toBe(false);
  });

  it("does not treat private suffixes (github.io) as registrable domains", () => {
    const r = parseDomainInput("myname.github.io");
    expect(r.ok).toBe(false);
  });
});

describe("buildVariant", () => {
  it("builds exact-name variants and validates them against the PSL", () => {
    expect(buildVariant("examplebrand", "co.id")?.domain).toBe("examplebrand.co.id");
    expect(buildVariant("examplebrand", "my.id")?.domain).toBe("examplebrand.my.id");
    expect(buildVariant("examplebrand", "store")?.domain).toBe("examplebrand.store");
  });

  it("maps a suffix to its top-level domain for RDAP lookup", () => {
    expect(tldOf("co.id")).toBe("id");
    expect(tldOf("com")).toBe("com");
  });
});
