export const APP_TIMEZONE = "Asia/Jakarta";

const dateTimeFmt = new Intl.DateTimeFormat("id-ID", {
  timeZone: APP_TIMEZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFmt = new Intl.DateTimeFormat("id-ID", {
  timeZone: APP_TIMEZONE,
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** "25 Sep 2026, 08.15 WIB" */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return `${dateTimeFmt.format(d)} WIB`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return dateFmt.format(d);
}

export function formatRelative(value: string | null | undefined, now = new Date()): string {
  if (!value) return "belum pernah";
  const diff = now.getTime() - new Date(value).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "baru saja";
  if (min < 60) return `${min} menit lalu`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}
