import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { SuffixPicker } from "@/components/suffix-picker";
import { Alert, EmptyState, PageHeader } from "@/components/ui";
import { requireOwnerPage } from "@/lib/auth";
import { DEFAULT_SUFFIXES } from "@/lib/domains/extensions";
import { formatDateTime } from "@/lib/format";
import type { RegistrationStatus } from "@/lib/monitor/transition";
import { STATUS_META, STATUS_ORDER } from "@/lib/status";
import { suffixSupport } from "@/lib/support";
import { addDomain } from "../actions";

type Variant = {
  id: string;
  domain_id: string;
  fqdn: string;
  suffix: string;
  status: RegistrationStatus;
  is_mine: boolean;
  is_active: boolean;
  baseline_status: string | null;
  last_checked_at: string | null;
  status_changed_at: string | null;
};

export default async function DomainsPage(props: PageProps<"/domains">) {
  const { supabase } = await requireOwnerPage();
  const sp = await props.searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().toLowerCase();
  const statusFilter = typeof sp.status === "string" && sp.status in STATUS_META ? (sp.status as RegistrationStatus) : "";
  const mineFilter = sp.mine === "1";

  const [domainsRes, variantsRes, settingsRes, support] = await Promise.all([
    supabase.from("domains").select("id, base_domain, notes, is_active, created_at").order("base_domain"),
    supabase
      .from("monitored_domains")
      .select("id, domain_id, fqdn, suffix, status, is_mine, is_active, baseline_status, last_checked_at, status_changed_at")
      .order("fqdn"),
    supabase.from("app_settings").select("default_suffixes").eq("singleton", true).maybeSingle(),
    suffixSupport(),
  ]);

  if (domainsRes.error || variantsRes.error) {
    return (
      <Alert tone="error" title="Data tidak bisa dimuat">
        {domainsRes.error?.message ?? variantsRes.error?.message}. Pastikan file supabase/migrations/0001_init.sql sudah
        dijalankan di Supabase.
      </Alert>
    );
  }

  const domains = domainsRes.data ?? [];
  const variants = (variantsRes.data ?? []) as Variant[];
  const defaults = (settingsRes.data?.default_suffixes as string[] | undefined) ?? DEFAULT_SUFFIXES;
  const byDomain = new Map<string, Variant[]>();
  for (const v of variants) byDomain.set(v.domain_id, [...(byDomain.get(v.domain_id) ?? []), v]);
  const domainName = new Map(domains.map((d) => [d.id as string, d.base_domain as string]));

  const filtered = variants.filter(
    (v) =>
      (!q || v.fqdn.includes(q) || (domainName.get(v.domain_id) ?? "").includes(q)) &&
      (!statusFilter || v.status === statusFilter) &&
      (!mineFilter || v.is_mine),
  );

  return (
    <>
      <PageHeader title="Domain Saya" description="Tambah domain milik Anda dan pilih ekstensi lain yang ingin dipantau." />

      <section className="card p-4 sm:p-6">
        <h2 className="mb-4 font-semibold">Tambah domain</h2>
        {!support.live ? (
          <div className="mb-4">
            <Alert tone="warning">
              Daftar server RDAP dari IANA sedang tidak bisa diambil, jadi informasi dukungan ekstensi memakai data
              cadangan bawaan aplikasi.
            </Alert>
          </div>
        ) : null}
        <ActionForm action={addDomain} className="space-y-4" resetOnSuccess>
          <div className="max-w-md">
            <label htmlFor="domain" className="label">
              Domain milik Anda
            </label>
            <input
              id="domain"
              name="domain"
              required
              placeholder="examplebrand.com"
              className="input"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-slate-500">
              Nama yang sama akan dipantau pada ekstensi yang Anda pilih di bawah. Ekstensi domain ini sendiri dilewati
              otomatis.
            </p>
          </div>
          <SuffixPicker items={support.items} selected={defaults} />
          <div className="max-w-md">
            <label htmlFor="notes" className="label">
              Catatan (opsional)
            </label>
            <input id="notes" name="notes" maxLength={500} className="input" />
          </div>
          <SubmitButton pendingText="Menambahkan…">Tambah domain</SubmitButton>
        </ActionForm>
      </section>

      {domains.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="Belum ada domain">Tambahkan domain pertama Anda dengan formulir di atas.</EmptyState>
        </div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {domains.map((d) => {
              const vs = byDomain.get(d.id as string) ?? [];
              const reg = vs.filter((v) => v.status === "registered" && !v.is_mine).length;
              return (
                <Link key={d.id} href={`/domains/${d.id}`} className="card block p-4 hover:border-indigo-300">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-semibold">{d.base_domain}</p>
                    {!d.is_active ? <span className="text-xs text-slate-500">Dijeda</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    {vs.length} varian · {reg} terdaftar (tidak ditandai milik saya)
                  </p>
                </Link>
              );
            })}
          </section>

          <section className="card mt-6">
            <form className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-end" method="get">
              <div className="flex-1">
                <label htmlFor="q" className="label">
                  Cari
                </label>
                <input id="q" name="q" defaultValue={q} placeholder="Nama domain…" className="input" />
              </div>
              <div>
                <label htmlFor="status" className="label">
                  Status
                </label>
                <select id="status" name="status" defaultValue={statusFilter} className="input">
                  <option value="">Semua status</option>
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_META[s].label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input type="checkbox" name="mine" value="1" defaultChecked={mineFilter} className="h-4 w-4" />
                Hanya milik saya
              </label>
              <button className="btn-secondary" type="submit">
                Terapkan
              </button>
            </form>
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-sm text-slate-500">Tidak ada varian yang cocok dengan filter.</p>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>Status</th>
                      <th>Keterangan</th>
                      <th>Terakhir dicek</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map((v) => (
                      <tr key={v.id} className={v.is_active ? "" : "opacity-60"}>
                        <td>
                          <Link
                            href={`/domains/${v.domain_id}/variants/${v.id}`}
                            className="font-medium text-indigo-700 hover:underline"
                          >
                            {v.fqdn}
                          </Link>
                          <p className="text-xs text-slate-500">dari {domainName.get(v.domain_id)}</p>
                        </td>
                        <td>
                          <StatusBadge status={v.status} />
                        </td>
                        <td className="text-xs text-slate-600">
                          {v.is_mine ? "Milik saya · " : ""}
                          {!v.is_active ? "Dijeda · " : ""}
                          {v.baseline_status === "registered" && !v.status_changed_at
                            ? "Sudah terdaftar saat pemantauan dimulai"
                            : v.status_changed_at
                              ? `Berubah ${formatDateTime(v.status_changed_at)}`
                              : ""}
                        </td>
                        <td className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(v.last_checked_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
