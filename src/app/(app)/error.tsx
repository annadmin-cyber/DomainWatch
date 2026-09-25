"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card mx-auto max-w-lg p-6">
      <h1 className="text-lg font-semibold">Terjadi kesalahan</h1>
      <p className="mt-2 text-sm text-slate-600">
        Halaman ini gagal dimuat. Biasanya ini karena koneksi ke database terputus atau skema database belum
        diterapkan.
      </p>
      {error.digest ? <p className="mt-2 font-mono text-xs text-slate-500">Kode: {error.digest}</p> : null}
      <button onClick={reset} className="btn-primary mt-4">
        Coba lagi
      </button>
    </div>
  );
}
