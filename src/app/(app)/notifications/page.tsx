import { Pill } from "@/components/status-badge";
import { SubmitButton } from "@/components/submit-button";
import { EmptyState, PageHeader } from "@/components/ui";
import { requireOwnerPage } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { markAllNotificationsRead, markNotificationRead } from "../actions";

const DELIVERY_LABEL: Record<string, { label: string; className: string }> = {
  pending: { label: "Telegram: menunggu", className: "bg-sky-50 text-sky-800 ring-sky-200" },
  sending: { label: "Telegram: sedang dikirim", className: "bg-sky-50 text-sky-800 ring-sky-200" },
  sent: { label: "Telegram: terkirim", className: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  failed: { label: "Telegram: gagal", className: "bg-red-50 text-red-800 ring-red-200" },
  skipped: { label: "Telegram: tidak aktif", className: "bg-slate-100 text-slate-700 ring-slate-300" },
};

export default async function NotificationsPage() {
  const { supabase } = await requireOwnerPage();
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, title, body, created_at, read_at, is_demo, notification_deliveries(status, last_error, sent_at)")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`Notifications query failed: ${error.message}`);
  const items = (data ?? []) as {
    id: string;
    kind: string;
    title: string;
    body: string;
    created_at: string;
    read_at: string | null;
    is_demo: boolean;
    notification_deliveries: { status: string; last_error: string | null; sent_at: string | null }[];
  }[];
  const unread = items.filter((n) => !n.read_at).length;

  return (
    <>
      <PageHeader
        title="Notifikasi"
        description="Peringatan pendaftaran baru dan perubahan status lainnya."
        actions={
          unread > 0 ? (
            <form action={markAllNotificationsRead}>
              <SubmitButton className="btn-secondary" pendingText="Menandai…">
                Tandai semua sudah dibaca
              </SubmitButton>
            </form>
          ) : null
        }
      />
      {items.length === 0 ? (
        <EmptyState title="Belum ada notifikasi">
          Notifikasi muncul di sini saat sebuah domain yang sebelumnya dikonfirmasi belum terdaftar kini terdaftar.
          Domain yang sudah terdaftar saat pemantauan dimulai tidak memicu peringatan.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {items.map((n) => {
            const delivery = n.notification_deliveries?.[0];
            const meta = delivery ? DELIVERY_LABEL[delivery.status] : null;
            return (
              <li key={n.id} className={`card p-4 ${n.read_at ? "" : "border-indigo-300 ring-1 ring-indigo-100"}`}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      {!n.read_at ? <span className="h-2 w-2 rounded-full bg-indigo-600" aria-label="Belum dibaca" /> : null}
                      <p className="font-semibold">{n.title}</p>
                      {n.kind === "alert" ? (
                        <Pill className="bg-amber-50 text-amber-800 ring-amber-200">Peringatan</Pill>
                      ) : (
                        <Pill className="bg-slate-100 text-slate-700 ring-slate-300">Info</Pill>
                      )}
                      {n.is_demo ? <Pill className="bg-purple-50 text-purple-800 ring-purple-200">DEMO</Pill> : null}
                      {meta ? <Pill className={meta.className}>{meta.label}</Pill> : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-700">{n.body}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatDateTime(n.created_at)}</p>
                    {delivery?.status === "failed" && delivery.last_error ? (
                      <p className="mt-1 text-xs text-red-700">{delivery.last_error}</p>
                    ) : null}
                  </div>
                  {!n.read_at ? (
                    <form action={markNotificationRead}>
                      <input type="hidden" name="id" value={n.id} />
                      <SubmitButton className="btn-secondary px-2.5 py-1 text-xs" pendingText="…">
                        Tandai dibaca
                      </SubmitButton>
                    </form>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
