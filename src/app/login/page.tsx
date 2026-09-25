import { redirect } from "next/navigation";
import { getOwner } from "@/lib/auth";
import { missingRequiredConfig } from "@/lib/env";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (missingRequiredConfig().length > 0) redirect("/setup");
  const { owner, signedIn } = await getOwner();
  if (owner) redirect("/");
  if (signedIn) redirect("/denied");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-2xl font-semibold tracking-tight">DomainWatch</p>
          <p className="mt-1 text-sm text-slate-600">Pemantauan domain pribadi. Hanya untuk pemilik.</p>
        </div>
        <div className="card p-6">
          <LoginForm />
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">
          Akun pemilik dibuat melalui dashboard Supabase. Lihat DEPLOY-VERCEL.md.
        </p>
      </div>
    </main>
  );
}
