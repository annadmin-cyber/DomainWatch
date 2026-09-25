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
};

export interface LookupProvider {
  readonly name: string;
  /** Whether the provider can look up this public suffix (e.g. "co.id"). */
  supports(suffix: string): Promise<boolean>;
  lookup(fqdn: string, suffix: string): Promise<LookupResult>;
}
