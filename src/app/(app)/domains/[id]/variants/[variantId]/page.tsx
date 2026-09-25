import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckButton } from "@/components/check-button";
import { Pill, StatusBadge } from "@/components/status-badge";
import { Alert, PageHeader } from "@/components/ui";
import { requireOwnerPage } from "@/lib/auth";
import { formatDate, formatDateTime } from "@/lib/format";
import type { RegistrationStatus } from "@/lib/monitor/transition";
import { EVENT_LABEL, STATUS_META } from "@/lib/status";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm sm:col-span-2 sm:mt-0">{children}</dd>
    </div>
  );
}

export default async function VariantDetailPage(props: PageProps<"/domains/[id]/variants/[variantId]">) {
  const { id, variantId } = await props.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(variantId)) notFound();
  const { supabase } = await requireOwnerPage();

  const [variantRes, checksRes, eventsRes] = await Promise.all([
    supabase.from("monitored_domains").select("*, domains(base_domain)").eq("id", variantId).eq("domain_id", id).maybeSingle(),
    supabase
      .from("check_results")
      .select("id, checked_at, status, source, http_status, error, duration_ms, confirmation")
      .eq("monitored_domain_id", variantId)
      .order("checked_at", { ascending: false })
      .limit(20),
    supabase
      .from("status_events")
      .select("id, event_type, detected_at, message, registration_date")
      .eq("monitored_domain_id", variantId)
      .order("detected_at", { ascending: false })
      .limit(20),
  ]);
  const v = variantRes.data;
  if (!v) notFound();
  const status = v.status as RegistrationStatus;
  const checks = checksRes.data ?? [];
  const events = eventsRes.data ?? [];
  const baseDomain = (v.domains as { base_domain: string } | null)?.base_domain;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/domains/${id}`} className="text-indigo-700 hover:underline">
          ← {baseDomain ?? "Domain"}
        </Link>
      </p>
      <PageHeader
        title={v.fqdn}
        description={v.is_mine ? "Ditandai sebagai milik Anda: perubahan tidak dikirim sebagai peringatan." : undefined}
        actions={<CheckButton id={v.id} className="btn-primary" />}
      />

      {status === "unsupported" ? (
        <div className="mb-4">
          <Alert tone="info" title="Ekstensi belum didukung">
            {v.status_detail ?? STATUS_META.unsupported.description}
          </Alert>
        </div>
      ) : null}
      {status === "unknown" ? (
        <div className="mb-4">
          <Alert tone="warning" title="Hasil terakhir tidak pasti">
            {v.last_error ?? STATUS_META.unknown.description} Status terdaftar/tidak terdaftar terakhir yang pasti tetap
            dipakai sebagai pembanding.
          </Alert>
        </div>
      ) : null}

      <section className="card">
        <dl className="divide-y divide-slate-100">
          <Field label="Nama domain lengkap">
            <span className="font-mono">{v.fqdn}</span>
          </Field>
          <Field label="Ekstensi">
            <span className="font-mono">.{v.suffix}</span>
          </Field>
          <Field label="Status pendaftaran">
            <div className="flex flex-col gap-1">
              <StatusBadge status={status} />
              <span className="text-xs text-slate-500">{STATUS_META[status].description}</span>
            </div>
          </Field>
          <Field label="Hasil pasti terakhir">
            {v.last_conclusive_status
              ? `${v.last_conclusive_status === "registered" ? "Terdaftar" : "Belum terdaftar"} (${formatDateTime(v.last_conclusive_at)})`
              : "Belum ada"}
          </Field>
          <Field label="Baseline">
            {v.baseline_status
              ? `${v.baseline_status === "registered" ? "Sudah terdaftar saat pemantauan dimulai" : "Belum terdaftar saat pemantauan dimulai"} · ${formatDateTime(v.baseline_at)}`
              : "Belum ada (menunggu pengecekan pertama yang berhasil)"}
          </Field>
          <Field label="Terakhir dicek">{formatDateTime(v.last_checked_at)}</Field>
          <Field label="Terakhir berhasil dicek">{formatDateTime(v.last_success_at)}</Field>
          <Field label="Perubahan terdeteksi">
            {v.status_changed_at ? (
              <>
                {formatDateTime(v.status_changed_at)}
                <span className="block text-xs text-slate-500">
                  Ini waktu aplikasi mendeteksi perubahan, bukan tanggal registrasi sebenarnya.
                </span>
              </>
            ) : (
              "Belum ada perubahan sejak baseline"
            )}
          </Field>
          <Field label="Tanggal registrasi (dari sumber)">
            {v.registration_date ? formatDate(v.registration_date) : "Tidak tersedia"}
          </Field>
          <Field label="Sumber data">{v.data_source ?? "—"}</Field>
          <Field label="Kesalahan terakhir">{v.last_error ?? "—"}</Field>
          <Field label="Status pemantauan">{v.is_active ? "Aktif" : "Dijeda"}</Field>
        </dl>
      </section>

      <section className="card mt-6">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="font-semibold">Riwayat perubahan</h2>
        </div>
        {events.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">Belum ada.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill className="bg-indigo-50 text-indigo-800 ring-indigo-200">{EVENT_LABEL[e.event_type]}</Pill>
                  <span className="text-xs text-slate-500">{formatDateTime(e.detected_at)}</span>
                </div>
                <p className="mt-1 text-slate-600">{e.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card mt-6">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="font-semibold">20 pengecekan terakhir</h2>
        </div>
        {checks.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">Belum pernah dicek.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Hasil</th>
                  <th>HTTP</th>
                  <th>Durasi</th>
                  <th>Catatan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {checks.map((c) => (
                  <tr key={c.id}>
                    <td className="whitespace-nowrap">{formatDateTime(c.checked_at)}</td>
                    <td>
                      <StatusBadge status={c.status as RegistrationStatus} />
                    </td>
                    <td>{c.http_status ?? "—"}</td>
                    <td className="whitespace-nowrap">{c.duration_ms != null ? `${c.duration_ms} ms` : "—"}</td>
                    <td className="max-w-sm text-xs text-slate-600">
                      {c.confirmation ? "Pemeriksaan konfirmasi. " : ""}
                      {c.error ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
