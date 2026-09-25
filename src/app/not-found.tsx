import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <div className="card p-6">
        <h1 className="text-lg font-semibold">Halaman tidak ditemukan</h1>
        <p className="mt-2 text-sm text-slate-600">
          Halaman ini tidak ada, atau domain yang dibuka sudah dihapus.
        </p>
        <Link href="/domains" className="btn-primary mt-4">
          Ke Domain Saya
        </Link>
      </div>
    </main>
  );
}
