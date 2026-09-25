/**
 * Extensions offered in the UI. Whether a lookup is actually possible is decided
 * at runtime by the provider (see providers/rdap/bootstrap.ts): an extension that
 * the IANA RDAP bootstrap registry does not list is reported as "unsupported".
 */
export const OFFERED_SUFFIXES = [
  "com",
  "net",
  "org",
  "co",
  "id",
  "co.id",
  "my.id",
  "web.id",
  "biz.id",
  "or.id",
  "io",
  "app",
  "dev",
  "online",
  "store",
  "shop",
  "site",
  "tech",
  "xyz",
  "info",
  "biz",
  "ai",
  "me",
  "asia",
] as const;

export const DEFAULT_SUFFIXES = [
  "com",
  "net",
  "org",
  "co",
  "id",
  "co.id",
  "io",
  "app",
  "online",
  "store",
  "xyz",
];

export function isOfferedSuffix(suffix: string): boolean {
  return (OFFERED_SUFFIXES as readonly string[]).includes(suffix);
}

/** Top-level label of a public suffix, e.g. "co.id" -> "id". */
export function tldOf(suffix: string): string {
  const parts = suffix.split(".");
  return parts[parts.length - 1];
}
