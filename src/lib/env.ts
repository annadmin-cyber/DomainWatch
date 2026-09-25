/**
 * Environment configuration. Public values (NEXT_PUBLIC_*) are inlined into
 * the browser bundle; everything else stays on the server.
 */

function isHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Supabase URL and publishable key, or null when missing or not a valid http(s) URL. */
export function publicSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key || !isHttpUrl(url)) return null;
  return { url, key };
}

export type ConfigItem = {
  name: string;
  ok: boolean;
  /** Present but unusable (e.g. a URL without https://). */
  invalid?: boolean;
  required: boolean;
  help: string;
};

/** Server-side view of which settings are present (never exposes values). */
export function configStatus(): ConfigItem[] {
  const has = (n: string) => Boolean(process.env[n]?.trim());
  const supabaseUrlOk = isHttpUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim());
  const cronSecretOk = (process.env.CRON_SECRET?.trim().length ?? 0) >= 16;
  return [
    {
      name: "NEXT_PUBLIC_SUPABASE_URL",
      ok: supabaseUrlOk,
      invalid: has("NEXT_PUBLIC_SUPABASE_URL") && !supabaseUrlOk,
      required: true,
      help: "Supabase > Project Settings > Data API > Project URL (diawali https://)",
    },
    {
      name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      ok: has("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
      required: true,
      help: "Supabase > Project Settings > API Keys > Publishable key",
    },
    {
      name: "SUPABASE_SECRET_KEY",
      ok: has("SUPABASE_SECRET_KEY"),
      required: true,
      help: "Supabase > Project Settings > API Keys > Secret key (rahasia)",
    },
    {
      name: "CRON_SECRET",
      ok: cronSecretOk,
      invalid: has("CRON_SECRET") && !cronSecretOk,
      required: true,
      help: "Teks acak minimal 16 karakter yang Anda buat sendiri (rahasia)",
    },
    {
      name: "TELEGRAM_BOT_TOKEN",
      ok: has("TELEGRAM_BOT_TOKEN"),
      required: false,
      help: "Opsional. Token dari @BotFather di Telegram (rahasia)",
    },
  ];
}

export function missingRequiredConfig(): string[] {
  return configStatus()
    .filter((c) => c.required && !c.ok)
    .map((c) => c.name);
}

/** "domainwatch.vercel.app/" -> "https://domainwatch.vercel.app"; null when not a valid http(s) URL. */
function normalizeBaseUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (!isHttpUrl(withScheme)) return null;
  const url = new URL(withScheme);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Base URL of this deployment, used for continuation runs. */
export function appBaseUrl(): string | null {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) {
    const url = normalizeBaseUrl(explicit);
    if (url) return url;
    console.warn("APP_URL is not a valid URL; using VERCEL_PROJECT_PRODUCTION_URL instead");
  }
  return normalizeBaseUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL);
}
