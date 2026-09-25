import type { RegistrationStatus } from "@/lib/monitor/transition";

export const STATUS_META: Record<RegistrationStatus, { label: string; className: string; description: string }> = {
  registered: {
    label: "Terdaftar",
    className: "bg-amber-50 text-amber-800 ring-amber-200",
    description: "Sumber data resmi menyatakan domain ini sudah terdaftar.",
  },
  unregistered: {
    label: "Belum terdaftar",
    className: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    description:
      "Registri menyatakan domain ini tidak ditemukan. Ini tidak selalu berarti domain bisa dibeli (misalnya domain premium, dicadangkan, atau dalam masa tunggu).",
  },
  unknown: {
    label: "Tidak diketahui",
    className: "bg-orange-50 text-orange-800 ring-orange-200",
    description: "Pengecekan terakhir tidak memberikan hasil pasti (timeout, rate limit, atau gangguan server).",
  },
  unsupported: {
    label: "Tidak didukung",
    className: "bg-slate-100 text-slate-700 ring-slate-300",
    description: "Ekstensi ini belum bisa diperiksa otomatis oleh sumber data yang digunakan.",
  },
  not_checked: {
    label: "Belum dicek",
    className: "bg-sky-50 text-sky-800 ring-sky-200",
    description: "Domain ini belum pernah diperiksa.",
  },
};

export const STATUS_ORDER: RegistrationStatus[] = ["registered", "unregistered", "unknown", "unsupported", "not_checked"];

export const EVENT_LABEL: Record<string, string> = {
  baseline: "Baseline dibuat",
  new_registration: "Baru terdaftar",
  newly_detected_registered: "Baru terdeteksi terdaftar",
  became_unregistered: "Menjadi tidak terdaftar",
  own_domain_change: "Perubahan domain milik Anda",
};

export const RUN_STATUS_LABEL: Record<string, { label: string; className: string }> = {
  running: { label: "Berjalan", className: "bg-sky-50 text-sky-800 ring-sky-200" },
  success: { label: "Berhasil", className: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  partial: { label: "Sebagian", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  failed: { label: "Gagal", className: "bg-red-50 text-red-800 ring-red-200" },
  skipped: { label: "Dilewati", className: "bg-slate-100 text-slate-700 ring-slate-300" },
};

export const TRIGGER_LABEL: Record<string, string> = {
  cron: "Terjadwal",
  continuation: "Lanjutan",
  manual: "Manual",
};
