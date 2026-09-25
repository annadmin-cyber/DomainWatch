import { configStatus } from "@/lib/env";
import { diagnoseSupabase, type DiagnosticLine, type SupabaseDiagnostics } from "@/lib/supabase/diagnostics";

// The connection check runs on every request, never from a cached render.
export const dynamic = "force-dynamic";

const TONE: Record<DiagnosticLine["tone"], { label: string; className: string }> = {
  ok: { label: "OK", className: "text-emerald-700" },
  warning: { label: "Perhatian", className: "text-amber-700" },
  error: { label: "Masalah", className: "text-red-700" },
};

export default async function SetupPage() {
  const items = configStatus();
  const missing = items.filter((i) => i.required && !i.ok);
  let diagnostics: SupabaseDiagnostics | null = null;
  try {
    diagnostics = await diagnoseSupabase();
  } catch {
    diagnostics = { projectRef: null, lines: [{ tone: "error", text: "Pemeriksaan tidak bisa dijalankan" }] };
  }
  const problems = diagnostics?.lines.some((l) => l.tone === "error") ?? false;

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Konfigurasi DomainWatch</h1>
      <p className="mt-2 text-sm text-slate-600">
        {missing.length > 0
          ? "Aplikasi belum bisa digunakan karena beberapa pengaturan (environment variables) belum diisi atau isinya belum benar di Vercel."
          : problems
            ? "Semua pengaturan wajib sudah terisi, tetapi pemeriksaan koneksi di bawah menemukan masalah."
            : "Semua pengaturan wajib sudah terisi. Silakan buka halaman login."}
      </p>
      <div className="card mt-6 divide-y divide-slate-100">
        {items.map((i) => (
          <div key={i.name} className="flex items-start justify-between gap-4 px-4 py-3">
            <div>
              <p className="font-mono text-sm">{i.name}</p>
              <p className="text-xs text-slate-500">{i.help}</p>
            </div>
            <span
              className={`whitespace-nowrap text-sm font-medium ${
                i.ok ? "text-emerald-700" : i.required ? "text-red-700" : "text-slate-500"
              }`}
            >
              {i.ok ? "Terisi" : i.invalid ? "Tidak valid" : i.required ? "Belum diisi" : "Opsional"}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-slate-600">
        Isi nilainya di Vercel: Project &gt; Settings &gt; Environment Variables, lalu lakukan Redeploy. Panduan lengkap
        ada di file DEPLOY-VERCEL.md.
      </p>

      {diagnostics ? (
        <section className="mt-8">
          <h2 className="font-semibold">Pemeriksaan koneksi Supabase</h2>
          <p className="mt-1 text-sm text-slate-600">
            {diagnostics.projectRef ? (
              <>
                Proyek Supabase yang dipakai: <span className="font-mono">{diagnostics.projectRef}</span>. Kode ini harus
                sama dengan kode di alamat dashboard Supabase Anda (supabase.com/dashboard/project/
                <span className="font-mono">{diagnostics.projectRef}</span>).
              </>
            ) : (
              "Kode proyek Supabase tidak bisa dibaca dari NEXT_PUBLIC_SUPABASE_URL."
            )}
          </p>
          <ul className="card mt-3 divide-y divide-slate-100">
            {diagnostics.lines.map((l) => (
              <li key={l.text} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                <div>
                  <p>{l.text}</p>
                  {l.hint ? <p className="mt-0.5 text-xs text-slate-500">{l.hint}</p> : null}
                </div>
                <span className={`whitespace-nowrap font-medium ${TONE[l.tone].className}`}>{TONE[l.tone].label}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {missing.length === 0 ? (
        <a href="/login" className="btn-primary mt-6">
          Ke halaman login
        </a>
      ) : null}
    </main>
  );
}
