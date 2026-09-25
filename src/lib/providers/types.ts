/**
 * Registration lookup provider contract. Application logic (monitor engine,
 * change detection) depends only on this interface, so another provider can be
 * added without touching it.
 */

export type LookupStatus = "registered" | "unregistered" | "unknown" | "unsupported";

export type LookupResult = {
  status: LookupStatus;
  /** Human-readable source, e.g. "RDAP (rdap.verisign.com)" */
  source: string;
  httpStatus?: number;
  /** Registration date, only when the source provides it */
  registrationDate?: string;
  /** Why the result is unknown/unsupported (Indonesian, shown in UI) */
  error?: string;
  durationMs: number;
  /**
   * No request was sent because the run's time ran out. Such a result is not
   * recorded; the domain is left for a later (continuation) run.
   */
  deferred?: boolean;
};

export type LookupOptions = {
  /** Epoch ms after which no new request may start; the result is then "unknown". */
  deadline?: number;
};

export interface LookupProvider {
  readonly name: string;
  /** Whether the provider can look up this public suffix (e.g. "co.id"). */
  supports(suffix: string): Promise<boolean>;
  lookup(fqdn: string, suffix: string, options?: LookupOptions): Promise<LookupResult>;
}
