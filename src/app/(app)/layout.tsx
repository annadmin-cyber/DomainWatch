import { redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { Nav } from "@/components/nav";
import { requireOwnerPage } from "@/lib/auth";
import { missingRequiredConfig } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  if (missingRequiredConfig().length > 0) redirect("/setup");
  const owner = await requireOwnerPage();
  const { count } = await owner.supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between gap-4">
            <span className="text-lg font-semibold tracking-tight">DomainWatch</span>
            <form action={signOut} className="sm:hidden">
              <button className="text-sm text-slate-600 hover:text-slate-900" type="submit">
                Keluar
              </button>
            </form>
          </div>
          <Nav unread={count ?? 0} />
          <div className="hidden items-center gap-3 sm:flex">
            <span className="max-w-[12rem] truncate text-xs text-slate-500">{owner.email}</span>
            <form action={signOut}>
              <button className="text-sm text-slate-600 hover:text-slate-900" type="submit">
                Keluar
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
