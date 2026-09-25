/**
 * Environment configuration. Public values (NEXT_PUBLIC_*) are inlined into
 * the browser bundle; everything else stays on the server.
 */

export function publicSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

export type ConfigItem = {
  name: string;
  ok: boolean;
  required: boolean;
  help: string;
};

/** Server-side view of which settings are present (never exposes values). */
export function configStatus(): ConfigItem[] {
  const has = (n: string) => Boolean(process.env[n]?.trim());
  return [
    {
      name: "NEXT_PUBLIC_SUPABASE_URL",
      ok: has("NEXT_PUBLIC_SUPABASE_URL"),
      required: true,
      help: "Supabase > Project Settings > Data API > Project URL",
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
      ok: has("CRON_SECRET") && (process.env.CRON_SECRET?.trim().length ?? 0) >= 16,
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

/** Base URL of this deployment, used for continuation runs. */
export function appBaseUrl(): string | null {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (prod) return `https://${prod}`;
  return null;
}
