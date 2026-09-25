/**
 * IANA RDAP bootstrap registry for domain names (RFC 9224).
 * https://data.iana.org/rdap/dns.json maps TLDs to authoritative RDAP servers.
 */

export const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

export type BootstrapMap = Map<string, string[]>;

/**
 * Fallback used only when the live registry cannot be fetched. Entries were
 * copied from the IANA registry published 2026-09-16. Any TLD missing here and
 * in the live registry is reported as unsupported.
 */
export const BOOTSTRAP_SNAPSHOT: Record<string, string> = {
  com: "https://rdap.verisign.com/com/v1/",
  net: "https://rdap.verisign.com/net/v1/",
  org: "https://rdap.publicinterestregistry.org/rdap/",
  id: "https://rdap.pandi.id/rdap/",
  app: "https://pubapi.registry.google/rdap/",
  dev: "https://pubapi.registry.google/rdap/",
  online: "https://rdap.radix.host/rdap/",
  store: "https://rdap.radix.host/rdap/",
  site: "https://rdap.radix.host/rdap/",
  tech: "https://rdap.radix.host/rdap/",
  xyz: "https://rdap.centralnic.com/xyz/",
  biz: "https://rdap.nic.biz/",
  info: "https://rdap.identitydigital.services/rdap/",
  shop: "https://rdap.gmoregistry.net/rdap/",
};

type BootstrapJson = {
  services?: unknown;
};

export function parseBootstrap(json: unknown): BootstrapMap {
  const map: BootstrapMap = new Map();
  const services = (json as BootstrapJson)?.services;
  if (!Array.isArray(services)) throw new Error("Invalid RDAP bootstrap document");
  for (const entry of services) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [tlds, urls] = entry as [unknown, unknown];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    const httpsUrls = urls
      .filter((u): u is string => typeof u === "string")
      .sort((a, b) => Number(b.startsWith("https://")) - Number(a.startsWith("https://")))
      .map((u) => (u.endsWith("/") ? u : `${u}/`));
    if (httpsUrls.length === 0) continue;
    for (const tld of tlds) {
      if (typeof tld === "string") map.set(tld.toLowerCase(), httpsUrls);
    }
  }
  if (map.size === 0) throw new Error("Empty RDAP bootstrap document");
  return map;
}

export function snapshotBootstrap(): BootstrapMap {
  return new Map(Object.entries(BOOTSTRAP_SNAPSHOT).map(([tld, url]) => [tld, [url]]));
}

const CACHE_MS = 12 * 60 * 60 * 1000;
/** After a failed fetch, try the live registry again this much sooner. */
const RETRY_MS = 10 * 60 * 1000;
type Loaded = { map: BootstrapMap; fetchedAt: number; live: boolean };
let cached: Loaded | null = null;
let inflight: Promise<Loaded> | null = null;

async function fetchBootstrap(fetchImpl: typeof fetch): Promise<Loaded> {
  try {
    const res = await fetchImpl(IANA_BOOTSTRAP_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const map = parseBootstrap(await res.json());
    cached = { map, fetchedAt: Date.now(), live: true };
  } catch (err) {
    // An expired live list is far better than the 14-TLD snapshot, so keep it.
    const retryAt = Date.now() - CACHE_MS + RETRY_MS;
    if (cached?.live) {
      console.warn("RDAP bootstrap fetch failed, keeping the previous IANA list:", err);
      cached = { ...cached, fetchedAt: retryAt };
    } else {
      console.warn("RDAP bootstrap fetch failed, using bundled snapshot:", err);
      cached = { map: snapshotBootstrap(), fetchedAt: retryAt, live: false };
    }
  }
  return cached;
}

export async function loadBootstrap(
  fetchImpl: typeof fetch = fetch,
): Promise<{ map: BootstrapMap; live: boolean }> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached;
  // Parallel lookups and page renders share one request.
  inflight ??= fetchBootstrap(fetchImpl).finally(() => {
    inflight = null;
  });
  return inflight;
}

export function resetBootstrapCache() {
  cached = null;
  inflight = null;
}
