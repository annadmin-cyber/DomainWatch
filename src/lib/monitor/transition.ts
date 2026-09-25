import { formatDate, formatDateTime } from "@/lib/format";
import type { LookupResult } from "@/lib/providers/types";

export type RegistrationStatus = "not_checked" | "registered" | "unregistered" | "unknown" | "unsupported";
export type Conclusive = "registered" | "unregistered";

export type EventType =
  | "baseline"
  | "new_registration"
  | "newly_detected_registered"
  | "became_unregistered"
  | "own_domain_change";

/** The subset of a monitored_domains row that change detection needs. */
export type DomainState = {
  id: string;
  fqdn: string;
  suffix: string;
  is_mine: boolean;
  status: RegistrationStatus;
  last_conclusive_status: Conclusive | null;
  last_conclusive_at: string | null;
  last_confirmed_unregistered_at: string | null;
  baseline_status: Conclusive | null;
  consecutive_failures: number;
};

export type DomainUpdate = {
  status: RegistrationStatus;
  status_detail: string | null;
  last_checked_at: string;
  last_error: string | null;
  consecutive_failures: number;
  data_source: string;
  last_success_at?: string;
  last_conclusive_status?: Conclusive;
  last_conclusive_at?: string;
  last_confirmed_unregistered_at?: string;
  baseline_status?: Conclusive;
  baseline_at?: string;
  status_changed_at?: string;
  registration_date?: string | null;
};

export type NewEvent = {
  event_type: EventType;
  previous_status: string | null;
  new_status: Conclusive;
  previous_confirmed_unregistered_at: string | null;
  registration_date: string | null;
  message: string;
  dedupe_key: string;
  /** Create an in-app notification */
  notify: boolean;
  /** Also push to external channels (Telegram) */
  alert: boolean;
  title: string;
};

export type Decision = {
  update: DomainUpdate;
  event: NewEvent | null;
};

export const BASELINE_REGISTERED_LABEL = "Sudah terdaftar saat pemantauan dimulai";
export const BASELINE_UNREGISTERED_LABEL = "Belum terdaftar saat pemantauan dimulai";

/**
 * Any conclusive result that contradicts the last conclusive status must be
 * confirmed by a second lookup before it is accepted. This prevents a single
 * spurious answer from creating (or later re-arming) a registration alert.
 */
export function needsConfirmation(state: DomainState, primary: LookupResult): boolean {
  if (primary.status !== "registered" && primary.status !== "unregistered") return false;
  return state.last_conclusive_status !== null && state.last_conclusive_status !== primary.status;
}

/**
 * A previous "unregistered" counts as directly confirmed only if it came from
 * the immediately preceding check and that check was recent (daily schedule
 * plus Vercel Hobby timing jitter). Otherwise the change time is uncertain.
 */
export const DIRECT_CONFIRMATION_MAX_AGE_MS = 30 * 60 * 60 * 1000;

function regDateSentence(date: string | null | undefined): string {
  return date ? ` Tanggal registrasi menurut sumber data: ${formatDate(date)}.` : "";
}

export function decideTransition(
  state: DomainState,
  primary: LookupResult,
  confirmation: LookupResult | undefined,
  now: Date,
): Decision {
  const nowIso = now.toISOString();
  const base = {
    last_checked_at: nowIso,
    data_source: primary.source,
  };

  if (primary.status === "unsupported") {
    return {
      update: {
        ...base,
        status: "unsupported",
        status_detail: primary.error ?? "Ekstensi ini belum didukung.",
        last_error: null,
        consecutive_failures: 0,
      },
      event: null,
    };
  }

  if (primary.status === "unknown") {
    return {
      update: {
        ...base,
        status: "unknown",
        status_detail: primary.error ?? "Status tidak dapat dipastikan.",
        last_error: primary.error ?? "Status tidak dapat dipastikan.",
        consecutive_failures: state.consecutive_failures + 1,
      },
      event: null,
    };
  }

  if (needsConfirmation(state, primary) && confirmation?.status !== primary.status) {
    const label = primary.status === "registered" ? "terdaftar" : "belum terdaftar";
    const msg = `Hasil terbaru menunjukkan ${label}, tetapi pemeriksaan ulang tidak mengonfirmasinya. Akan dicek lagi pada jadwal berikutnya.`;
    return {
      update: {
        ...base,
        status: "unknown",
        status_detail: msg,
        last_error: msg,
        consecutive_failures: state.consecutive_failures + 1,
      },
      event: null,
    };
  }

  const result: Conclusive = primary.status as Conclusive;
  const regDate = result === "registered" ? (confirmation?.registrationDate ?? primary.registrationDate ?? null) : null;
  const update: DomainUpdate = {
    ...base,
    status: result,
    status_detail: null,
    last_error: null,
    consecutive_failures: 0,
    last_success_at: nowIso,
    last_conclusive_status: result,
    last_conclusive_at: nowIso,
    registration_date: regDate,
  };
  if (result === "unregistered") update.last_confirmed_unregistered_at = nowIso;

  // First conclusive result establishes the baseline. Never an alert.
  if (!state.baseline_status) {
    update.baseline_status = result;
    update.baseline_at = nowIso;
    update.status_detail = result === "registered" ? BASELINE_REGISTERED_LABEL : BASELINE_UNREGISTERED_LABEL;
    return {
      update,
      event: {
        event_type: "baseline",
        previous_status: null,
        new_status: result,
        previous_confirmed_unregistered_at: null,
        registration_date: regDate,
        title: `Baseline ${state.fqdn}`,
        message: `${state.fqdn}: ${
          result === "registered" ? BASELINE_REGISTERED_LABEL : BASELINE_UNREGISTERED_LABEL
        } (${formatDateTime(now)}).`,
        dedupe_key: `baseline:${state.id}`,
        notify: false,
        alert: false,
      },
    };
  }

  const prev = state.last_conclusive_status;

  if (prev === "unregistered" && result === "registered") {
    update.status_changed_at = nowIso;
    const prevAt = state.last_confirmed_unregistered_at;
    const dedupe = `reg:${state.id}:${prevAt ?? "none"}`;
    if (state.is_mine) {
      return {
        update,
        event: {
          event_type: "own_domain_change",
          previous_status: "unregistered",
          new_status: "registered",
          previous_confirmed_unregistered_at: prevAt,
          registration_date: regDate,
          title: `${state.fqdn} (milik Anda) kini terdaftar`,
          message: `${state.fqdn} ditandai sebagai milik Anda dan kini terdaftar. Tidak dikirim sebagai peringatan pihak ketiga.`,
          dedupe_key: dedupe,
          notify: false,
          alert: false,
        },
      };
    }
    const directlyConfirmed =
      state.status === "unregistered" &&
      prevAt !== null &&
      now.getTime() - Date.parse(prevAt) <= DIRECT_CONFIRMATION_MAX_AGE_MS;
    if (directlyConfirmed) {
      return {
        update,
        event: {
          event_type: "new_registration",
          previous_status: "unregistered",
          new_status: "registered",
          previous_confirmed_unregistered_at: prevAt,
          registration_date: regDate,
          title: `${state.fqdn} sekarang terdaftar`,
          message:
            `${state.fqdn} sekarang terdaftar. Sebelumnya dikonfirmasi belum terdaftar pada ${formatDateTime(prevAt)}. ` +
            `Perubahan terdeteksi pada ${formatDateTime(now)}.` +
            regDateSentence(regDate) +
            " Identitas pendaftar tidak diketahui dari data ini.",
          dedupe_key: dedupe,
          notify: true,
          alert: true,
        },
      };
    }
    return {
      update,
      event: {
        event_type: "newly_detected_registered",
        previous_status: state.status,
        new_status: "registered",
        previous_confirmed_unregistered_at: prevAt,
        registration_date: regDate,
        title: `${state.fqdn} baru terdeteksi sebagai terdaftar`,
        message:
          `${state.fqdn} baru terdeteksi sebagai terdaftar. Terakhir dikonfirmasi belum terdaftar pada ${formatDateTime(prevAt)}, ` +
          `tetapi sesudahnya tidak ada pemeriksaan yang berhasil, sehingga waktu perubahan pastinya tidak diketahui. ` +
          `Terdeteksi pada ${formatDateTime(now)}.` +
          regDateSentence(regDate),
        dedupe_key: dedupe,
        notify: true,
        alert: true,
      },
    };
  }

  if (prev === "registered" && result === "unregistered") {
    update.status_changed_at = nowIso;
    return {
      update,
      event: {
        event_type: "became_unregistered",
        previous_status: "registered",
        new_status: "unregistered",
        previous_confirmed_unregistered_at: null,
        registration_date: null,
        title: `${state.fqdn} kini tidak terdaftar`,
        message:
          `${state.fqdn} sebelumnya terdaftar, tetapi pemeriksaan pada ${formatDateTime(now)} menunjukkan belum terdaftar. ` +
          `Ini tidak selalu berarti domain bisa langsung dibeli (bisa sedang dalam masa tunggu registri).`,
        dedupe_key: `unreg:${state.id}:${state.last_conclusive_at ?? "none"}`,
        notify: true,
        alert: false,
      },
    };
  }

  return { update, event: null };
}
