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
  static readonly BREAKER_THRESHOLD = 3;

  constructor(opts: RdapOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.sleep = opts.sleep ?? defaultSleep;
    this.limiter = new HostLimiter(opts.perHostIntervalMs ?? 1_000, this.sleep);
    this.bootstrapOverride = opts.bootstrap;
  }

  private async bootstrap(): Promise<BootstrapMap> {
    if (this.bootstrapOverride) return this.bootstrapOverride;
    return (await loadBootstrap(this.fetchImpl)).map;
  }

  async baseUrlFor(suffix: string): Promise<string | null> {
    const map = await this.bootstrap();
    return map.get(tldOf(suffix))?.[0] ?? null;
  }

  async supports(suffix: string): Promise<boolean> {
    return (await this.baseUrlFor(suffix)) !== null;
  }

  async lookup(fqdn: string, suffix: string, options: LookupOptions = {}): Promise<LookupResult> {
    const started = Date.now();
    const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
    const timeLeft = () => deadline - Date.now();
    const base = await this.baseUrlFor(suffix);
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
        const stop = (error: string) => ({
          kind: "retry" as const,
          httpStatus: undefined,
          retryAfterMs: undefined,
          error,
          stop: true,
        });
        // A registry that keeps failing is skipped for the rest of this run so
        // it cannot tie up every worker; its domains are reported as unknown.
        if ((this.hostFailures.get(host) ?? 0) >= RdapProvider.BREAKER_THRESHOLD) {
          return stop(`Server RDAP ${host} gagal merespons berulang kali, jadi dilewati sementara pada proses ini.`);
        }
        // Waiting in the per-host queue may have used up the remaining time.
        const left = timeLeft();
        if (left < 2_000) return stop("Batas waktu proses tercapai sebelum pengecekan dimulai.");
        const result = await this.once(url, fqdn, Math.min(this.timeoutMs, left));
        if (result.kind === "final") this.hostFailures.set(host, 0);
        else this.hostFailures.set(host, (this.hostFailures.get(host) ?? 0) + 1);
        return result;
      });
      lastHttp = outcome.httpStatus;
      if (outcome.kind === "final") {
        return { ...outcome.result, source, durationMs: Date.now() - started };
      }
      lastError = outcome.error;
      if ("stop" in outcome && outcome.stop) break;
      // A timeout already cost the full timeout; retrying it would mostly stall the run.
      if ("timedOut" in outcome && outcome.timedOut) break;
      if (attempt < this.maxAttempts) {
        const wait = outcome.retryAfterMs ?? 1_500 * attempt;
        // Do not stall the whole run for one registry, and never retry past the deadline.
        if (wait > 10_000 || timeLeft() - wait < 5_000) break;
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
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        kind: "retry",
        timedOut,
        error: timedOut
          ? "Server RDAP tidak merespons tepat waktu (timeout)."
          : "Gagal terhubung ke server RDAP.",
      };
    }

    const status = res.status;
    const contentType = res.headers.get("content-type") ?? "";

    if (status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      return {
        kind: "retry",
        httpStatus: status,
        error: "Server RDAP membatasi jumlah permintaan (rate limit).",
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
      };
    }
    if (status >= 500) {
      return { kind: "retry", httpStatus: status, error: `Server RDAP mengalami gangguan (HTTP ${status}).` };
    }

    if (status === 404) {
      // A registry "object not found" answer means the name is not registered.
      // An HTML 404 usually means a wrong URL or a proxy page, which is not evidence.
      if (/text\/html/i.test(contentType)) {
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
      } catch {
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
