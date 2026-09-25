import "server-only";
import { publicSupabaseConfig } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Connection self-check for the public /setup page. Every line is a fixed
 * status message: no key values, emails or user ids are ever included.
 */
export type DiagnosticLine = { tone: "ok" | "warning" | "error"; text: string; hint?: string };

export type SupabaseDiagnostics = { projectRef: string | null; lines: DiagnosticLine[] };

const TIMEOUT_MS = 5_000;

/** "https://abcd1234.supabase.co" -> "abcd1234" (not secret); null for other hosts. */
export function projectRefOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : null;
  } catch {
    return null;
  }
}

/** Checks the URL and publishable key against Supabase Auth's public settings endpoint. */
export async function checkPublicKey(url: string, key: string, fetchImpl: typeof fetch = fetch): Promise<DiagnosticLine[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${url.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return [
      {
        tone: "error",
        text: "Tidak bisa menghubungi Supabase di alamat ini",
        hint: "Periksa NEXT_PUBLIC_SUPABASE_URL (contoh https://abcd1234.supabase.co) dan pastikan proyek Supabase tidak sedang di-pause.",
      },
    ];
  }
  if (res.status === 401 || res.status === 403) {
    return [
      {
        tone: "error",
        text: "Kunci publik (NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) tidak cocok dengan proyek ini",
        hint: "Salin ulang Publishable key dari Supabase > Project Settings > API Keys proyek yang sama, lalu Redeploy.",
      },
    ];
  }
  if (res.status !== 200) {
    return [
      {
        tone: "error",
        text: `Alamat Supabase menjawab dengan kode HTTP ${res.status}`,
        hint: "Pastikan NEXT_PUBLIC_SUPABASE_URL adalah Project URL dari Supabase > Project Settings > Data API.",
      },
    ];
  }

  const lines: DiagnosticLine[] = [{ tone: "ok", text: "Kunci publik cocok dengan proyek Supabase" }];
  const settings = (await res.json().catch(() => null)) as {
    external?: { email?: boolean };
    disable_signup?: boolean;
  } | null;
  const emailEnabled = settings?.external?.email;
  if (emailEnabled === true) lines.push({ tone: "ok", text: "Login dengan email aktif" });
  else if (emailEnabled === false) {
    lines.push({
      tone: "error",
      text: "Login dengan email dimatikan, jadi login selalu gagal",
      hint: 'Supabase > Authentication > Sign In / Providers > Email: aktifkan lagi. Yang boleh dimatikan hanya "Allow new users to sign up".',
    });
  }
  if (settings?.disable_signup === true) lines.push({ tone: "ok", text: "Pendaftaran akun baru dimatikan" });
  else if (settings?.disable_signup === false) {
    lines.push({
      tone: "warning",
      text: "Pendaftaran akun baru masih terbuka",
      hint: 'Matikan "Allow new users to sign up" di Supabase > Authentication > Sign In / Providers supaya orang lain tidak bisa membuat akun.',
    });
  }
  return lines;
}

type AdminResult = {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
  status: number;
};

/** Maps a read of public.app_owner with the secret key to status lines. */
export function describeSecretKeyCheck(res: AdminResult): DiagnosticLine[] {
  const { error, status } = res;
  if (!error) {
    const hasOwner = (res.data?.length ?? 0) > 0;
    return [
      { tone: "ok", text: "Kunci rahasia valid dan skema database terpasang" },
      hasOwner
        ? { tone: "ok", text: "Akun pemilik sudah didaftarkan" }
        : {
            tone: "warning",
            text: "Akun pemilik belum didaftarkan",
            hint: "Jalankan supabase/setup-owner.sql di Supabase > SQL Editor (lihat DEPLOY-VERCEL.md Langkah 5).",
          },
    ];
  }
  const message = error.message ?? "";
  // A publishable key in SUPABASE_SECRET_KEY acts as "anon", which has no table access.
  if (error.code === "42501" || status === 403) {
    return [
      {
        tone: "error",
        text: "Kunci rahasia tidak punya akses admin",
        hint: "SUPABASE_SECRET_KEY harus berisi Secret key (sb_secret_...), bukan Publishable key.",
      },
    ];
  }
  if (status === 401 || /invalid api key|jwt/i.test(message)) {
    return [
      {
        tone: "error",
        text: "Kunci rahasia (SUPABASE_SECRET_KEY) tidak valid untuk proyek ini",
        hint: "Salin ulang Secret key (diawali sb_secret_) dari Supabase > Project Settings > API Keys proyek yang sama, lalu Redeploy.",
      },
    ];
  }
  if (error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(message)) {
    return [
      {
        tone: "error",
        text: "Tabel belum ada: jalankan migrasi",
        hint: "Jalankan semua file di supabase/migrations secara berurutan di Supabase > SQL Editor (DEPLOY-VERCEL.md Langkah 4).",
      },
    ];
  }
  if (status === 0) {
    return [{ tone: "error", text: "Tidak bisa menghubungi database Supabase" }];
  }
  return [
    {
      tone: "error",
      text: `Pemeriksaan database gagal (kode ${error.code || status})`,
      hint: "Periksa SUPABASE_SECRET_KEY dan pastikan semua migrasi sudah dijalankan.",
    },
  ];
}

async function checkSecretKey(): Promise<DiagnosticLine[]> {
  let db;
  try {
    db = createAdminClient();
  } catch {
    return [{ tone: "error", text: "Kunci rahasia (SUPABASE_SECRET_KEY) belum diisi" }];
  }
  // Only whether a row exists is used; the owner's id is never read.
  const res = await db.from("app_owner").select("singleton").limit(1).abortSignal(AbortSignal.timeout(TIMEOUT_MS));
  return describeSecretKeyCheck(res);
}

/** Runs both checks. Never throws; returns null when the public config is missing. */
export async function diagnoseSupabase(): Promise<SupabaseDiagnostics | null> {
  const cfg = publicSupabaseConfig();
  if (!cfg) return null;
  const safely = async (fn: () => Promise<DiagnosticLine[]>): Promise<DiagnosticLine[]> => {
    try {
      return await fn();
    } catch {
      return [{ tone: "error", text: "Pemeriksaan tidak bisa dijalankan" }];
    }
  };
  const [publicLines, secretLines] = await Promise.all([
    safely(() => checkPublicKey(cfg.url, cfg.key)),
    safely(checkSecretKey),
  ]);
  return { projectRef: projectRefOf(cfg.url), lines: [...publicLines, ...secretLines] };
}
