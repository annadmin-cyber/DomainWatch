import { parse } from "tldts";

export type ParsedDomain = {
  /** Registrable domain in lowercase ASCII (punycode), e.g. "examplebrand.co.id" */
  domain: string;
  /** The label before the public suffix, e.g. "examplebrand" */
  label: string;
  /** ICANN public suffix, e.g. "co.id" */
  suffix: string;
};

export type ParseResult =
  | { ok: true; value: ParsedDomain }
  | { ok: false; error: string };

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function toAsciiHostname(input: string): string | null {
  try {
    return new URL(`http://${input}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Parse a user-supplied domain into label + public suffix using the Public
 * Suffix List (via tldts), so multi-part suffixes such as "co.id" are handled.
 * Accepts an optional scheme, path and a leading "www.".
 */
export function parseDomainInput(raw: string): ParseResult {
  let input = raw.trim().toLowerCase();
  if (!input) return { ok: false, error: "Nama domain wajib diisi." };

  input = input.replace(/^[a-z]+:\/\//, "");
  input = input.split(/[/?#]/)[0];
  input = input.replace(/\.$/, "");
  if (input.startsWith("www.")) input = input.slice(4);

  if (/\s/.test(input)) return { ok: false, error: "Nama domain tidak boleh mengandung spasi." };

  const ascii = toAsciiHostname(input);
  if (!ascii) return { ok: false, error: "Format nama domain tidak valid." };

  const result = parse(ascii, { allowPrivateDomains: false });
  if (result.isIp) return { ok: false, error: "Alamat IP bukan nama domain." };
  if (!result.domain || !result.publicSuffix || !result.domainWithoutSuffix || !result.isIcann) {
    return {
      ok: false,
      error: "Ekstensi domain tidak dikenali. Contoh yang benar: examplebrand.com atau examplebrand.co.id.",
    };
  }
  if (result.subdomain) {
    return {
      ok: false,
      error: `Masukkan domain utama saja (misalnya ${result.domain}), bukan subdomain.`,
    };
  }
  const label = result.domainWithoutSuffix;
  if (!LABEL_RE.test(label)) {
    return { ok: false, error: "Nama domain hanya boleh berisi huruf, angka, dan tanda hubung." };
  }
  return { ok: true, value: { domain: result.domain, label, suffix: result.publicSuffix } };
}

/** Build a variant FQDN from a label and a suffix, validating the result with the PSL. */
export function buildVariant(label: string, suffix: string): ParsedDomain | null {
  const fqdn = `${label}.${suffix}`.toLowerCase();
  const result = parse(fqdn, { allowPrivateDomains: false });
  if (result.domain !== fqdn || result.publicSuffix !== suffix || !result.isIcann) return null;
  return { domain: fqdn, label, suffix };
}
