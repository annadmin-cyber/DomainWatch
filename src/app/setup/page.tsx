import { configStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  const items = configStatus();
  const missing = items.filter((i) => i.required && !i.ok);
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Konfigurasi DomainWatch</h1>
      <p className="mt-2 text-sm text-slate-600">
        {missing.length > 0
          ? "Aplikasi belum bisa digunakan karena beberapa pengaturan (environment variables) belum diisi di Vercel."
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
              {i.ok ? "Terisi" : i.required ? "Belum diisi" : "Opsional"}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-slate-600">
        Isi nilainya di Vercel: Project &gt; Settings &gt; Environment Variables, lalu lakukan Redeploy. Panduan lengkap
        ada di file DEPLOY-VERCEL.md.
      </p>
      {missing.length === 0 ? (
        <a href="/login" className="btn-primary mt-6">
          Ke halaman login
        </a>
      ) : null}
    </main>
  );
}
