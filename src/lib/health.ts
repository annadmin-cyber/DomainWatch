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

/** A variant is overdue (or without a recent result) after this long. */
export const STALE_AFTER_MS = 26 * HOUR;

/** Counts of active variants, computed with head count queries by the caller. */
export type VariantHealthCounts = {
  /** Not checked at all within STALE_AFTER_MS (includes never checked). */
  overdue: number;
  /** Supported, but no conclusive result (registered/unregistered) within STALE_AFTER_MS. */
  inconclusive: number;
};

/**
 * Health is based on evidence that scheduled runs actually executed,
 * never on the mere existence of a cron configuration.
 */
export function monitoringHealth(runs: RunRow[], counts: VariantHealthCounts, now: Date): Health {
  const scheduled = runs.filter((r) => r.trigger === "cron" || r.trigger === "continuation");
  const lastScheduled = scheduled[0];
  const { overdue, inconclusive } = counts;

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
  if (age > STALE_AFTER_MS) {
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
  if (inconclusive > 0) {
    return {
      tone: "warning",
      title: `${inconclusive} varian belum mendapat hasil pasti dalam 26 jam terakhir`,
      detail:
        "Varian ini sudah dicek, tetapi hasilnya tidak pasti (server registri tidak merespons, membatasi permintaan, atau hasil belum terkonfirmasi). " +
        "Selama itu, pendaftaran baru pada varian ini belum bisa terdeteksi. Penyebabnya ada di daftar \"Pengecekan tertunda atau gagal\" di bawah.",
    };
  }
  return {
    tone: "success",
    title: "Pemantauan otomatis berjalan",
    detail: "Proses terjadwal terakhir berjalan dalam 26 jam terakhir dan semua varian aktif sudah dicek.",
  };
}
