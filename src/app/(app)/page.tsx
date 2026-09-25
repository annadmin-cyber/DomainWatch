import Link from "next/link";
import { CheckButton } from "@/components/check-button";
import { Pill, StatusBadge } from "@/components/status-badge";
import { Alert, EmptyState, PageHeader, StatCard } from "@/components/ui";
import { requireOwnerPage } from "@/lib/auth";
import { formatDateTime, formatRelative } from "@/lib/format";
import { monitoringHealth, STALE_AFTER_MS, type RunRow } from "@/lib/health";
import type { RegistrationStatus } from "@/lib/monitor/transition";
import { RunsTable } from "@/components/runs-table";
import { EVENT_LABEL } from "@/lib/status";

/** Result of a head count query; a failed query is shown by error.tsx, never as zero. */
function countOf(res: { count: number | null; error: { message: string } | null }): number {
  if (res.error) throw new Error(`Dashboard query failed: ${res.error.message}`);
  return res.count ?? 0;
}

export default async function DashboardPage() {
  const { supabase } = await requireOwnerPage();
  const now = new Date();
  const staleIso = new Date(now.getTime() - STALE_AFTER_MS).toISOString();
  // Counts are computed in the database (head requests return no rows), so they
  // stay correct however many variants exist.
  const variantCount = () => supabase.from("monitored_domains").select("*", { count: "exact", head: true });
  const activeCount = () => variantCount().eq("is_active", true);

  const [
    domainsRes,
    totalRes,
    activeRes,
    pendingRes,
    failedRes,
    overdueRes,
    inconclusiveRes,
    attentionRes,
    eventsRes,
    runsRes,
    lastSuccessRes,
  ] = await Promise.all([
    supabase.from("domains").select("*", { count: "exact", head: true }),
    variantCount(),
    activeCount(),
    activeCount().eq("status", "not_checked"),
    activeCount().eq("status", "unknown"),
    activeCount().or(`last_checked_at.is.null,last_checked_at.lt."${staleIso}"`),
    activeCount()
      .neq("status", "unsupported")
      .or(`last_success_at.is.null,last_success_at.lt."${staleIso}"`),
    // Descending status puts failed ("unknown") before never checked ("not_checked").
    supabase
      .from("monitored_domains")
      .select("id, fqdn, domain_id, status, last_error")
      .eq("is_active", true)
      .in("status", ["unknown", "not_checked"])
      .order("status", { ascending: false })
      .order("fqdn")
      .limit(12),
    supabase
      .from("status_events")
      .select("id, event_type, detected_at, message, monitored_domains(id, fqdn, domain_id)")
      .in("event_type", ["new_registration", "newly_detected_registered", "became_unregistered", "own_domain_change"])
      .order("detected_at", { ascending: false })
      .limit(8),
    supabase.from("monitor_runs").select("*").order("started_at", { ascending: false }).limit(10),
    supabase
      .from("monitor_runs")
      .select("*")
      .eq("status", "success")
      .order("started_at", { ascending: false })
      .limit(1),
  ]);

  for (const res of [attentionRes, eventsRes, runsRes, lastSuccessRes]) {
    if (res.error) throw new Error(`Dashboard query failed: ${res.error.message}`);
  }
  const domainCount = countOf(domainsRes);
  const total = countOf(totalRes);
  const active = countOf(activeRes);
  const pending = countOf(pendingRes);
  const failed = countOf(failedRes);
  const attention = (attentionRes.data ?? []) as {
    id: string;
    fqdn: string;
    domain_id: string;
    status: RegistrationStatus;
    last_error: string | null;
  }[];
  const runs = (runsRes.data ?? []) as RunRow[];
  const lastSuccess = (lastSuccessRes.data?.[0] ?? null) as RunRow | null;
  const health = monitoringHealth(runs, { overdue: countOf(overdueRes), inconclusive: countOf(inconclusiveRes) }, now);
  const events = (eventsRes.data ?? []) as unknown as {
    id: string;
    event_type: string;
    detected_at: string;
    message: string;
    monitored_domains: { id: string; fqdn: string; domain_id: string } | null;
  }[];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Ringkasan pemantauan domain Anda. Waktu ditampilkan dalam WIB."
        actions={<CheckButton scope="all" label="Cek semua sekarang" className="btn-primary" />}
      />

      <div className="mb-6">
        <Alert tone={health.tone} title={health.title}>
          {health.detail}
        </Alert>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Domain utama" value={domainCount} />
        <StatCard label="Varian dipantau" value={active} hint={`${total - active} dijeda`} />
        <StatCard
          label="Tertunda / gagal"
          value={`${pending} / ${failed}`}
          hint="Belum dicek / hasil tidak pasti"
        />
        <StatCard
          label="Pemantauan sukses terakhir"
          value={<span className="text-base">{lastSuccess ? formatRelative(lastSuccess.started_at, now) : "Belum ada"}</span>}
          hint={lastSuccess ? formatDateTime(lastSuccess.finished_at ?? lastSuccess.started_at) : undefined}
        />
      </div>

      {total === 0 ? (
        <div className="mt-8">
          <EmptyState title="Belum ada domain yang dipantau" action={{ href: "/domains", label: "Tambah domain pertama" }}>
            Tambahkan domain milik Anda, lalu pilih ekstensi lain yang ingin dipantau.
          </EmptyState>
        </div>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section className="card">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="font-semibold">Perubahan pendaftaran terbaru</h2>
          </div>
          {events.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">Belum ada perubahan yang terdeteksi.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {events.map((e) => (
                <li key={e.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill className="bg-indigo-50 text-indigo-800 ring-indigo-200">{EVENT_LABEL[e.event_type]}</Pill>
                    {e.monitored_domains ? (
                      <Link
                        className="font-medium text-indigo-700 hover:underline"
                        href={`/domains/${e.monitored_domains.domain_id}/variants/${e.monitored_domains.id}`}
                      >
                        {e.monitored_domains.fqdn}
                      </Link>
                    ) : null}
                    <span className="text-xs text-slate-500">{formatDateTime(e.detected_at)}</span>
                  </div>
                  <p className="mt-1 text-slate-600">{e.message}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="font-semibold">Pengecekan tertunda atau gagal</h2>
          </div>
          {attention.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">Tidak ada. Semua varian aktif sudah memiliki hasil.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {attention.map((v) => (
                <li key={v.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                  <div>
                    <Link
                      className="font-medium text-indigo-700 hover:underline"
                      href={`/domains/${v.domain_id}/variants/${v.id}`}
                    >
                      {v.fqdn}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {v.status === "unknown" ? (v.last_error ?? "Hasil tidak pasti") : "Belum pernah dicek"}
                    </p>
                  </div>
                  <StatusBadge status={v.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card mt-6">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="font-semibold">Riwayat proses pemantauan</h2>
          <Link href="/settings#monitoring" className="text-sm text-indigo-700 hover:underline">
            Detail
          </Link>
        </div>
        <RunsTable runs={runs.slice(0, 5)} now={now} />
      </section>
    </>
  );
}
