import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { CheckButton } from "@/components/check-button";
import { StatusBadge } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { SuffixPicker } from "@/components/suffix-picker";
import { PageHeader } from "@/components/ui";
import { requireOwnerPage } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import type { RegistrationStatus } from "@/lib/monitor/transition";
import { suffixSupport } from "@/lib/support";
import { deleteDomain, setVariantActive, setVariantMine, updateDomain } from "../../actions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DomainDetailPage(props: PageProps<"/domains/[id]">) {
  const { id } = await props.params;
  if (!UUID_RE.test(id)) notFound();
  const { supabase } = await requireOwnerPage();

  const [domainRes, variantsRes, support] = await Promise.all([
    supabase.from("domains").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("monitored_domains")
      .select("id, fqdn, suffix, status, is_mine, is_active, baseline_status, last_checked_at, last_success_at, last_error, status_changed_at")
      .eq("domain_id", id)
      .order("fqdn"),
    suffixSupport(),
  ]);
  // A failed query must not render as "no variants": saving the form below
  // would then remove every variant. error.tsx shows the failure instead.
  const loadError = domainRes.error ?? variantsRes.error;
  if (loadError) throw new Error(`Domain page query failed: ${loadError.message}`);
  const domain = domainRes.data;
  if (!domain) notFound();
  const variants = (variantsRes.data ?? []) as {
    id: string;
    fqdn: string;
    suffix: string;
    status: RegistrationStatus;
    is_mine: boolean;
    is_active: boolean;
    baseline_status: string | null;
    last_checked_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    status_changed_at: string | null;
  }[];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/domains" className="text-indigo-700 hover:underline">
          ← Domain Saya
        </Link>
      </p>
      <PageHeader
        title={domain.base_domain}
        description={`Ekstensi .${domain.suffix} · ditambahkan ${formatDateTime(domain.created_at)}`}
      />

      <section className="card">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="font-semibold">Varian yang dipantau</h2>
        </div>
        {variants.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">Belum ada ekstensi yang dipilih.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Terakhir dicek</th>
                  <th>Milik saya</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {variants.map((v) => (
                  <tr key={v.id} className={v.is_active ? "" : "opacity-60"}>
                    <td>
                      <Link
                        href={`/domains/${id}/variants/${v.id}`}
                        className="font-medium text-indigo-700 hover:underline"
                      >
                        {v.fqdn}
                      </Link>
                      {v.baseline_status === "registered" && !v.status_changed_at ? (
                        <p className="text-xs text-slate-500">Sudah terdaftar saat pemantauan dimulai</p>
                      ) : null}
                      {v.status === "unknown" && v.last_error ? (
                        <p className="max-w-xs text-xs text-orange-700">{v.last_error}</p>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge status={v.status} />
                    </td>
                    <td className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(v.last_checked_at)}</td>
                    <td>
                      <form action={setVariantMine}>
                        <input type="hidden" name="id" value={v.id} />
                        <input type="hidden" name="value" value={String(!v.is_mine)} />
                        <button type="submit" className="text-xs font-medium text-indigo-700 hover:underline">
                          {v.is_mine ? "Ya (ubah)" : "Tandai milik saya"}
                        </button>
                      </form>
                    </td>
                    <td>
                      <div className="flex flex-wrap items-start gap-2">
                        <CheckButton id={v.id} className="btn-secondary px-2.5 py-1 text-xs" />
                        <form action={setVariantActive}>
                          <input type="hidden" name="id" value={v.id} />
                          <input type="hidden" name="value" value={String(!v.is_active)} />
                          <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">
                            {v.is_active ? "Jeda" : "Aktifkan"}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card mt-6 p-4 sm:p-6">
        <h2 className="mb-4 font-semibold">Ubah pengaturan domain</h2>
        <ActionForm action={updateDomain} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          <SuffixPicker items={support.items} selected={variants.map((v) => v.suffix)} exclude={domain.suffix} />
          <div className="max-w-md">
            <label htmlFor="notes" className="label">
              Catatan
            </label>
            <input id="notes" name="notes" defaultValue={domain.notes ?? ""} maxLength={500} className="input" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="is_active" defaultChecked={domain.is_active} className="h-4 w-4" />
            Pantau domain ini (hapus centang untuk menjeda semua varian)
          </label>
          <p className="text-xs text-slate-500">
            Menghapus centang ekstensi akan menghapus varian itu beserta riwayat pengecekannya.
          </p>
          <SubmitButton>Simpan perubahan</SubmitButton>
        </ActionForm>
      </section>

      <section className="card mt-6 border-red-200 p-4 sm:p-6">
        <h2 className="font-semibold text-red-800">Hapus domain</h2>
        <p className="mt-1 text-sm text-slate-600">
          Menghapus {domain.base_domain} beserta semua varian, riwayat pengecekan, dan notifikasinya.
        </p>
        <form action={deleteDomain} className="mt-3">
          <input type="hidden" name="id" value={id} />
          <SubmitButton
            className="btn-danger"
            pendingText="Menghapus…"
            confirm={`Hapus ${domain.base_domain} dan semua riwayatnya? Tindakan ini tidak bisa dibatalkan.`}
          >
            Hapus domain
          </SubmitButton>
        </form>
      </section>
    </>
  );
}
