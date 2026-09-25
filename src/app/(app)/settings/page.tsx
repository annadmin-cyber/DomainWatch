import { ActionForm } from "@/components/action-form";
import { RunsTable } from "@/components/runs-table";
import { SubmitButton } from "@/components/submit-button";
import { SuffixPicker } from "@/components/suffix-picker";
import { TelegramTools } from "@/components/telegram-tools";
import { Alert, PageHeader } from "@/components/ui";
import { requireOwnerPage } from "@/lib/auth";
import { DEFAULT_SUFFIXES } from "@/lib/domains/extensions";
import { configStatus } from "@/lib/env";
import type { RunRow } from "@/lib/health";
import { MONITOR_DEFAULTS } from "@/lib/monitor/engine";
import { MAX_CHAIN_DEPTH } from "@/lib/monitor/runtime";
import { suffixSupport } from "@/lib/support";
import {
  detectTelegramChats,
  saveDefaultSuffixes,
  saveTelegramSettings,
  sendTelegramTest,
} from "../actions";

export default async function SettingsPage() {
  const { supabase, email } = await requireOwnerPage();
  const now = new Date();
  const [settingsRes, runsRes, support] = await Promise.all([
    supabase.from("app_settings").select("*").eq("singleton", true).maybeSingle(),
    supabase.from("monitor_runs").select("*").order("started_at", { ascending: false }).limit(20),
    suffixSupport(),
  ]);
  const loadError = settingsRes.error ?? runsRes.error;
  if (loadError) throw new Error(`Settings page query failed: ${loadError.message}`);
  const settings = settingsRes.data;
  const config = configStatus();
  const tokenConfigured = config.find((c) => c.name === "TELEGRAM_BOT_TOKEN")?.ok ?? false;
  const supported = support.items.filter((i) => i.supported).map((i) => `.${i.suffix}`);
  const unsupported = support.items.filter((i) => !i.supported).map((i) => `.${i.suffix}`);

  return (
    <>
      <PageHeader title="Pengaturan" description={`Login sebagai ${email ?? "pemilik"}.`} />

      <div className="space-y-6">
        <section className="card p-4 sm:p-6">
          <h2 className="font-semibold">Notifikasi Telegram (opsional)</h2>
          <p className="mt-1 text-sm text-slate-600">
            Aplikasi tetap berfungsi tanpa Telegram; semua peringatan selalu muncul di halaman Notifikasi.
          </p>
          {!tokenConfigured ? (
            <div className="mt-4">
              <Alert tone="info" title="Token bot belum diisi">
                Untuk mengaktifkan Telegram, isi environment variable TELEGRAM_BOT_TOKEN di Vercel lalu Redeploy.
              </Alert>
            </div>
          ) : null}
          <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-slate-700">
            <li>
              Di Telegram, buka <span className="font-mono">@BotFather</span>, kirim <span className="font-mono">/newbot</span>,
              lalu ikuti petunjuknya. Anda akan menerima token bot.
            </li>
            <li>
              Masukkan token itu di Vercel sebagai <span className="font-mono">TELEGRAM_BOT_TOKEN</span> (jangan
              dibagikan ke siapa pun), lalu Redeploy.
            </li>
            <li>Buka bot baru Anda di Telegram dan tekan Start (atau kirim pesan apa saja).</li>
            <li>Tekan &quot;Cari Chat ID saya&quot;, salin angkanya ke kolom Chat ID, centang Aktifkan, lalu Simpan.</li>
            <li>Tekan &quot;Kirim pesan uji&quot; untuk memastikan pesan sampai.</li>
          </ol>
          <ActionForm action={saveTelegramSettings} className="mt-4 space-y-3">
            <div className="max-w-xs">
              <label htmlFor="telegram_chat_id" className="label">
                Chat ID
              </label>
              <input
                id="telegram_chat_id"
                name="telegram_chat_id"
                defaultValue={settings?.telegram_chat_id ?? ""}
                inputMode="numeric"
                className="input"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="telegram_enabled"
                defaultChecked={Boolean(settings?.telegram_enabled)}
                className="h-4 w-4"
              />
              Aktifkan notifikasi Telegram
            </label>
            <SubmitButton>Simpan</SubmitButton>
          </ActionForm>
          <div className="mt-4 border-t border-slate-100 pt-4">
            <TelegramTools detect={detectTelegramChats} test={sendTelegramTest} tokenConfigured={tokenConfigured} />
          </div>
        </section>

        <section className="card p-4 sm:p-6">
          <h2 className="mb-4 font-semibold">Ekstensi bawaan untuk domain baru</h2>
          <ActionForm action={saveDefaultSuffixes} className="space-y-4">
            <SuffixPicker
              items={support.items}
              selected={(settings?.default_suffixes as string[] | undefined) ?? DEFAULT_SUFFIXES}
            />
            <SubmitButton>Simpan</SubmitButton>
          </ActionForm>
        </section>

        <section id="monitoring" className="card">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="font-semibold">Riwayat pemantauan</h2>
            <p className="mt-1 text-sm text-slate-600">
              Status di sini berasal dari catatan proses yang benar-benar berjalan, bukan dari jadwal yang
              dikonfigurasi.
            </p>
          </div>
          <RunsTable runs={(runsRes.data ?? []) as RunRow[]} now={now} />
        </section>

        <section className="card p-4 sm:p-6 text-sm text-slate-700">
          <h2 className="font-semibold text-slate-900">Sumber data dan kapasitas</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Sumber data: RDAP resmi dari registri masing-masing ekstensi, dicari melalui daftar IANA
              (data.iana.org/rdap/dns.json). Gratis, tanpa API key.
              {!support.live ? " Saat ini memakai daftar cadangan karena daftar IANA tidak bisa diambil." : ""}
            </li>
            <li>Didukung saat ini: {supported.join(", ") || "—"}.</li>
            <li>Tidak didukung saat ini (tidak ada server RDAP di daftar IANA): {unsupported.join(", ") || "—"}.</li>
            <li>
              Jadwal: sekali sehari pukul 01.00 UTC (sekitar 08.00–09.00 WIB; paket Hobby Vercel bisa meleset hingga 59
              menit).
            </li>
            <li>
              Setiap proses berjalan maksimal sekitar {Math.round(MONITOR_DEFAULTS.budgetMs / 1000)} detik dengan{" "}
              {MONITOR_DEFAULTS.concurrency} pengecekan paralel dan jeda minimal 1 detik per server registri. Sisa domain
              dilanjutkan otomatis hingga {MAX_CHAIN_DEPTH} proses lanjutan per hari.
            </li>
            <li>
              Hasil &quot;Belum terdaftar&quot; tidak menjamin domain bisa dibeli. Timeout, rate limit, dan gangguan
              server selalu dicatat sebagai &quot;Tidak diketahui&quot;, tidak pernah sebagai belum terdaftar.
            </li>
          </ul>
        </section>

        <section className="card p-4 sm:p-6">
          <h2 className="font-semibold">Status konfigurasi server</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {config.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-3 py-2">
                <span className="font-mono text-xs sm:text-sm">{c.name}</span>
                <span className={c.ok ? "text-emerald-700" : c.required ? "text-red-700" : "text-slate-500"}>
                  {c.ok ? "Terisi" : c.invalid ? "Tidak valid" : c.required ? "Belum diisi" : "Tidak diisi (opsional)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
