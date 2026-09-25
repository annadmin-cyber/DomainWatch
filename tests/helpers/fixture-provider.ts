import type { LookupProvider, LookupResult, LookupStatus } from "@/lib/providers/types";

/**
 * Controlled test provider: each domain returns a scripted sequence of
 * statuses. No network access, no real registrations.
 */
export class FixtureProvider implements LookupProvider {
  readonly name = "fixture";
  calls: string[] = [];
  private script = new Map<string, LookupStatus[]>();
  private fallback = new Map<string, LookupStatus>();

  /** Queue one-off results for a domain. */
  queue(fqdn: string, ...statuses: LookupStatus[]) {
    this.script.set(fqdn, [...(this.script.get(fqdn) ?? []), ...statuses]);
  }
  /** Result returned whenever the queue for a domain is empty. */
  set(fqdn: string, status: LookupStatus) {
    this.fallback.set(fqdn, status);
  }

  async supports() {
    return true;
  }

  async lookup(fqdn: string): Promise<LookupResult> {
    this.calls.push(fqdn);
    const q = this.script.get(fqdn);
    const status = q && q.length > 0 ? q.shift()! : (this.fallback.get(fqdn) ?? "unknown");
    return {
      status,
      source: "fixture",
      durationMs: 1,
      registrationDate: status === "registered" ? "2026-09-20T00:00:00.000Z" : undefined,
      error: status === "unknown" ? "fixture: simulated provider failure" : undefined,
    };
  }
}
