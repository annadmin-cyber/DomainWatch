import { tldOf } from "@/lib/domains/extensions";
import type { LookupOptions, LookupProvider, LookupResult } from "@/lib/providers/types";
import { loadBootstrap, type BootstrapMap } from "./bootstrap";

export type RdapOptions = {
  fetchImpl?: typeof fetch;
  /** Per-request timeout */
  timeoutMs?: number;
  /** Total attempts for transient failures (timeouts, 5xx, 429) */
  maxAttempts?: number;
  /** Minimum gap between two requests to the same RDAP host */
  perHostIntervalMs?: number;
  /** Override bootstrap (tests) */
  bootstrap?: BootstrapMap;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Longest wait (Retry-After or backoff) accepted within one run. */
const MAX_WAIT_MS = 10_000;
const TIMEOUT_ERROR = "Server RDAP tidak merespons tepat waktu (timeout).";

const isTimeout = (err: unknown) =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** Retry-After as delta-seconds or an HTTP date (RFC 9110); undefined when absent or not in the future. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Whether a 404 is the registry's own "object not found" answer: an empty body,
 * or JSON sent as RDAP or carrying RDAP error fields. HTML or plain-text pages
 * and generic gateway JSON ({"message": "Not Found"}) from a web server, load
 * balancer or wrong URL are not evidence that the name is unregistered.
 */
function isRdapNotFound(contentType: string, body: string): boolean {
  if (/html/i.test(contentType)) return false;
  if (body.trim() === "") return true;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  return /application\/rdap\+json/i.test(contentType) || "errorCode" in json || "rdapConformance" in json;
}

/** Serialises requests per host and spaces them out to respect registry rate limits. */
class HostLimiter {
  private next = new Map<string, Promise<void>>();
  constructor(
    private intervalMs: number,
    private sleep: (ms: number) => Promise<void>,
  ) {}

  async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.next.get(host) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.next.set(host, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      this.sleep(this.intervalMs).then(release);
    }
  }
}

type RdapEvent = { eventAction?: string; eventDate?: string };
type RdapDomain = {
  objectClassName?: string;
  ldhName?: string;
  unicodeName?: string;
  events?: RdapEvent[];
  errorCode?: number;
};

export class RdapProvider implements LookupProvider {
  readonly name = "RDAP";
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxAttempts: number;
  private sleep: (ms: number) => Promise<void>;
  private limiter: HostLimiter;
  private bootstrapOverride?: BootstrapMap;
  /** Consecutive transient failures per host (circuit breaker, per instance = per run). */
  private hostFailures = new Map<string, number>();
  /** Retry-After from a 429 applies to every lookup on that host, not just the one that got it. */
  private blockedUntil = new Map<string, number>();
  static readonly BREAKER_THRESHOLD = 3;

  constructor(opts: RdapOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.sleep = opts.sleep ?? defaultSleep;
    this.limiter = new HostLimiter(opts.perHostIntervalMs ?? 1_000, this.sleep);
    this.bootstrapOverride = opts.bootstrap;
  }

  private async bootstrap(): Promise<{ map: BootstrapMap; live: boolean }> {
    if (this.bootstrapOverride) return { map: this.bootstrapOverride, live: true };
    return loadBootstrap(this.fetchImpl);
  }

  async baseUrlFor(suffix: string): Promise<string | null> {
    const { map } = await this.bootstrap();
    return map.get(tldOf(suffix))?.[0] ?? null;
  }

  async supports(suffix: string): Promise<boolean> {
    return (await this.baseUrlFor(suffix)) !== null;
  }

  async lookup(fqdn: string, suffix: string, options: LookupOptions = {}): Promise<LookupResult> {
    const started = Date.now();
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    const timeLeft = () => deadline - Date.now();
    const { map, live } = await this.bootstrap();
    const base = map.get(tldOf(suffix))?.[0] ?? null;
    if (!base && !live) {
      // The bundled snapshot lists only common TLDs, so a missing entry proves nothing.
      return {
        status: "unknown",
        source: "RDAP (IANA bootstrap)",
        error: "Daftar server RDAP dari IANA sedang tidak bisa diambil, jadi ekstensi ini belum bisa diperiksa. Akan dicoba lagi pada proses berikutnya.",
        durationMs: Date.now() - started,
      };
    }
    if (!base) {
      return {
        status: "unsupported",
        source: "RDAP (IANA bootstrap)",
        error: `Ekstensi .${suffix} belum memiliki server RDAP resmi di daftar IANA, jadi statusnya tidak bisa diperiksa otomatis.`,
        durationMs: Date.now() - started,
      };
    }
    const url = `${base}domain/${encodeURIComponent(fqdn)}`;
    const host = new URL(url).host;
    const source = `RDAP (${host})`;

    let lastError = "";
    let lastHttp: number | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const outcome = await this.limiter.run(host, async () => {
        const stop = (error: string, deferred = false) => ({
          kind: "retry" as const,
          httpStatus: undefined,
          retryAfterMs: undefined,
          error,
          stop: true,
          deferred,
        });
        // A registry that keeps failing is skipped for the rest of this run so
        // it cannot tie up every worker; its domains are reported as unknown.
        if ((this.hostFailures.get(host) ?? 0) >= RdapProvider.BREAKER_THRESHOLD) {
          return stop(`Server RDAP ${host} gagal merespons berulang kali, jadi dilewati sementara pada proses ini.`);
        }
        const blockedFor = (this.blockedUntil.get(host) ?? 0) - Date.now();
        if (blockedFor > 0) {
          if (blockedFor > MAX_WAIT_MS || timeLeft() - blockedFor < 5_000) {
            return stop(`Server RDAP ${host} meminta jeda karena terlalu banyak permintaan (rate limit), jadi dilewati pada proses ini.`);
          }
          await this.sleep(blockedFor);
        }
        // Waiting in the per-host queue may have used up the remaining time.
        const left = timeLeft();
        if (left < 2_000) return stop("Batas waktu proses tercapai sebelum pengecekan dimulai.", true);
        const result = await this.once(url, fqdn, Math.min(this.timeoutMs, left));
        if (result.kind === "final") this.hostFailures.set(host, 0);
        else this.hostFailures.set(host, (this.hostFailures.get(host) ?? 0) + 1);
        if (result.kind === "retry" && result.retryAfterMs) {
          this.blockedUntil.set(host, Date.now() + result.retryAfterMs);
        }
        return result;
      });
      lastHttp = outcome.httpStatus;
      if (outcome.kind === "final") {
        return { ...outcome.result, source, durationMs: Date.now() - started };
      }
      lastError = outcome.error;
      if ("stop" in outcome && outcome.stop) {
        // Nothing was sent for this domain yet: leave it for a later run.
        if (outcome.deferred && attempt === 1) {
          return { status: "unknown", source, error: lastError, durationMs: Date.now() - started, deferred: true };
        }
        break;
      }
      // A timeout already cost the full timeout; retrying it would mostly stall the run.
      if ("timedOut" in outcome && outcome.timedOut) break;
      if (attempt < this.maxAttempts) {
        const wait = outcome.retryAfterMs ?? 1_500 * attempt;
        // Do not stall the whole run for one registry, and never retry past the deadline.
        if (wait > MAX_WAIT_MS || timeLeft() - wait < 5_000) break;
        await this.sleep(wait);
      }
    }
    return {
      status: "unknown",
      source,
      httpStatus: lastHttp,
      error: lastError,
      durationMs: Date.now() - started,
    };
  }

  private async once(
    url: string,
    fqdn: string,
    timeoutMs: number,
  ): Promise<
    | { kind: "final"; httpStatus?: number; result: Omit<LookupResult, "source" | "durationMs"> }
    | { kind: "retry"; httpStatus?: number; error: string; retryAfterMs?: number; timedOut?: boolean }
  > {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: "application/rdap+json, application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
        cache: "no-store",
      });
    } catch (err) {
      const timedOut = isTimeout(err);
      return { kind: "retry", timedOut, error: timedOut ? TIMEOUT_ERROR : "Gagal terhubung ke server RDAP." };
    }

    const status = res.status;
    const contentType = res.headers.get("content-type") ?? "";

    if (status === 429) {
      return {
        kind: "retry",
        httpStatus: status,
        error: "Server RDAP membatasi jumlah permintaan (rate limit).",
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      };
    }
    if (status >= 500) {
      return { kind: "retry", httpStatus: status, error: `Server RDAP mengalami gangguan (HTTP ${status}).` };
    }

    if (status === 404) {
      // A registry "object not found" answer means the name is not registered.
      let text: string | null;
      try {
        text = await res.text();
      } catch (err) {
        // A body that times out is a transient failure like any other timeout.
        if (isTimeout(err)) return { kind: "retry", httpStatus: status, timedOut: true, error: TIMEOUT_ERROR };
        text = null;
      }
      if (text === null || !isRdapNotFound(contentType, text)) {
        return {
          kind: "final",
          httpStatus: status,
          result: { status: "unknown", httpStatus: status, error: "Respons 404 dari server RDAP tidak valid (bukan format RDAP)." },
        };
      }
      return { kind: "final", httpStatus: status, result: { status: "unregistered", httpStatus: status } };
    }

    if (status === 200) {
      let body: RdapDomain;
      try {
        body = (await res.json()) as RdapDomain;
      } catch (err) {
        if (isTimeout(err)) return { kind: "retry", httpStatus: status, timedOut: true, error: TIMEOUT_ERROR };
        return {
          kind: "final",
          httpStatus: status,
          result: { status: "unknown", httpStatus: status, error: "Respons RDAP tidak bisa dibaca (JSON tidak valid)." },
        };
      }
      const name = (body.ldhName ?? "").toLowerCase().replace(/\.$/, "");
      if (body.objectClassName !== "domain" || (name && name !== fqdn)) {
        return {
          kind: "final",
          httpStatus: status,
          result: { status: "unknown", httpStatus: status, error: "Respons RDAP tidak sesuai dengan domain yang diminta." },
        };
      }
      const reg = body.events?.find((e) => e.eventAction === "registration")?.eventDate;
      const regDate = reg && !Number.isNaN(Date.parse(reg)) ? new Date(reg).toISOString() : undefined;
      return {
        kind: "final",
        httpStatus: status,
        result: { status: "registered", httpStatus: status, registrationDate: regDate },
      };
    }

    return {
      kind: "final",
      httpStatus: status,
      result: { status: "unknown", httpStatus: status, error: `Respons RDAP tidak terduga (HTTP ${status}).` },
    };
  }
}
