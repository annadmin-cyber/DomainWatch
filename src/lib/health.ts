export type RunRow = {
  id: string;
  trigger: "cron" | "continuation" | "manual";
  status: "running" | "success" | "partial" | "failed" | "skipped";
  started_at: string;
  finished_at: string | null;
  checked_count: number;
  conclusive_count: number;
  error_count: number;
  remaining_count: number;
  events_count: number;
  message: string | null;
};

export type Health = {
  tone: "success" | "warning" | "error" | "info";
  title: string;
  detail: string;
};

const HOUR = 60 * 60 * 1000;

/**
 * Health is based on evidence that scheduled runs actually executed,
 * never on the mere existence of a cron configuration.
 */
export function monitoringHealth(
  runs: RunRow[],
  activeVariants: { last_checked_at: string | null }[],
  now: Date,
): Health {
  const scheduled = runs.filter((r) => r.trigger === "cron" || r.trigger === "continuation");
  const lastScheduled = scheduled[0];
  const overdue = activeVariants.filter(
    (v) => !v.last_checked_at || now.getTime() - new Date(v.last_checked_at).getTime() > 26 * HOUR,
  ).length;

  if (!lastScheduled) {
    return {
      tone: "warning",
      title: "Jadwal otomatis belum pernah terbukti berjalan",
      detail:
        "Jadwal harian sudah diatur di vercel.json, tetapi belum ada catatan bahwa Vercel Cron pernah menjalankannya. " +
        "Setelah deploy, tunggu jadwal berikutnya (sekitar pukul 08.00–09.00 WIB) lalu periksa lagi halaman ini.",
    };
  }

  const age = now.getTime() - new Date(lastScheduled.started_at).getTime();
  const stale = lastScheduled.status === "running" && age > 6 * 60 * 1000;

  if (lastScheduled.status === "failed" || stale) {
    return {
      tone: "error",
      title: "Proses terjadwal terakhir gagal",
      detail: `${lastScheduled.message ?? "Proses berhenti sebelum selesai."} Buka Pengaturan > Riwayat pemantauan untuk detail.`,
    };
  }
  if (age > 26 * HOUR) {
    return {
      tone: "error",
      title: "Pemantauan terjadwal terlambat",
      detail: `Proses terjadwal terakhir berjalan lebih dari 26 jam yang lalu. Periksa Vercel > Settings > Cron Jobs dan log proyek.`,
    };
  }
  if (overdue > 0) {
    return {
      tone: "warning",
      title: `${overdue} varian belum dicek dalam 26 jam terakhir`,
      detail:
        "Proses terjadwal berjalan, tetapi sebagian domain belum sempat dicek (misalnya baru ditambahkan atau batas waktu tercapai). Proses lanjutan dan jadwal berikutnya akan mengeceknya.",
    };
  }
  return {
    tone: "success",
    title: "Pemantauan otomatis berjalan",
    detail: "Proses terjadwal terakhir berjalan dalam 26 jam terakhir dan semua varian aktif sudah dicek.",
  };
}
