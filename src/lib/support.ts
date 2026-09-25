import "server-only";
import { OFFERED_SUFFIXES } from "@/lib/domains/extensions";
import { loadBootstrap } from "@/lib/providers/rdap/bootstrap";
import { tldOf } from "@/lib/domains/extensions";

export type SuffixSupport = { suffix: string; supported: boolean };

/** Which offered extensions currently have an RDAP server in the IANA registry. */
export async function suffixSupport(): Promise<{ items: SuffixSupport[]; live: boolean }> {
  const { map, live } = await loadBootstrap();
  return {
    live,
    items: OFFERED_SUFFIXES.map((s) => ({ suffix: s, supported: map.has(tldOf(s)) })),
  };
}
