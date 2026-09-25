import { signOut } from "@/app/login/actions";

export default function DeniedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-md p-6">
        <h1 className="text-lg font-semibold">Akses ditolak</h1>
        <p className="mt-2 text-sm text-slate-600">
          Anda sudah login, tetapi akun ini belum terdaftar sebagai pemilik DomainWatch. Pemilik didaftarkan dengan
          menjalankan <code className="rounded bg-slate-100 px-1">supabase/setup-owner.sql</code> di SQL Editor
          Supabase menggunakan email akun ini.
        </p>
        <form action={signOut} className="mt-4">
          <button className="btn-secondary" type="submit">
            Keluar
          </button>
        </form>
      </div>
    </main>
  );
}
