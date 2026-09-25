import { Pill } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format";
import type { RunRow } from "@/lib/health";
import { RUN_STATUS_LABEL, TRIGGER_LABEL } from "@/lib/status";

export function RunsTable({ runs, now }: { runs: RunRow[]; now: Date }) {
  if (runs.length === 0) {
    return <p className="px-4 py-6 text-sm text-slate-500">Belum ada proses pemantauan yang pernah berjalan.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Mulai</th>
            <th>Jenis</th>
            <th>Status</th>
            <th>Dicek</th>
            <th>Gagal</th>
            <th>Sisa</th>
            <th>Keterangan</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((r) => {
            const meta = RUN_STATUS_LABEL[r.status] ?? RUN_STATUS_LABEL.failed;
            const stale = r.status === "running" && now.getTime() - new Date(r.started_at).getTime() > 6 * 60_000;
            return (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{formatDateTime(r.started_at)}</td>
                <td>{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
                <td>
                  {stale ? (
                    <Pill className="bg-red-50 text-red-800 ring-red-200">Terhenti</Pill>
                  ) : (
                    <Pill className={meta.className}>{meta.label}</Pill>
                  )}
                </td>
                <td>{r.checked_count}</td>
                <td>{r.error_count}</td>
                <td>{r.remaining_count}</td>
                <td className="max-w-xs text-xs text-slate-500">
                  {stale ? "Proses berhenti sebelum selesai (kemungkinan batas waktu server)." : (r.message ?? "—")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
