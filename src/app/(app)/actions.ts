"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner, UnauthorizedError, type OwnerContext } from "@/lib/auth";
import { isOfferedSuffix } from "@/lib/domains/extensions";
import { buildVariant, parseDomainInput } from "@/lib/domains/parse";
import { findRecentChats, sendTelegramMessage, telegramToken } from "@/lib/notify/telegram";
import { allowRequest } from "@/lib/rate-limit";

export type ActionState = { ok: boolean; message: string | null; data?: unknown };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function owner(): Promise<OwnerContext> {
  try {
    return await requireOwner();
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect(err.status === 401 ? "/login" : "/denied");
    throw err;
  }
}

function uuid(value: FormDataEntryValue | null): string {
  const s = String(value ?? "");
  if (!UUID_RE.test(s)) throw new Error("ID tidak valid");
  return s;
}

function selectedSuffixes(formData: FormData): string[] {
  return [...new Set(formData.getAll("suffixes").map(String))].filter(isOfferedSuffix);
}

/** Create variants for a main domain, skipping ones already monitored elsewhere. */
async function syncVariants(
  ctx: OwnerContext,
  domainId: string,
  label: string,
  ownSuffix: string,
  suffixes: string[],
): Promise<{ added: number; skipped: string[] }> {
  const wanted = suffixes
    .filter((s) => s !== ownSuffix)
    .map((s) => buildVariant(label, s))
    .filter((v): v is NonNullable<typeof v> => v !== null);
  if (wanted.length === 0) return { added: 0, skipped: [] };

  const { data: existing, error } = await ctx.supabase
    .from("monitored_domains")
    .select("fqdn, domain_id")
    .in(
      "fqdn",
      wanted.map((w) => w.domain),
    );
  if (error) throw new Error(error.message);

  const { data: mainDomains } = await ctx.supabase
    .from("domains")
    .select("base_domain")
    .in(
      "base_domain",
      wanted.map((w) => w.domain),
    );
  const mine = new Set((mainDomains ?? []).map((d) => d.base_domain as string));
  const taken = new Set((existing ?? []).map((e) => e.fqdn as string));
  const skipped = wanted.filter((w) => taken.has(w.domain)).map((w) => w.domain);
  const rows = wanted
    .filter((w) => !taken.has(w.domain))
    .map((w) => ({ domain_id: domainId, fqdn: w.domain, suffix: w.suffix, is_mine: mine.has(w.domain) }));
  if (rows.length > 0) {
    const { error: insErr } = await ctx.supabase.from("monitored_domains").insert(rows);
    if (insErr) throw new Error(insErr.message);
  }
  return { added: rows.length, skipped };
}

export async function addDomain(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await owner();
  const parsed = parseDomainInput(String(formData.get("domain") ?? ""));
  if (!parsed.ok) return { ok: false, message: parsed.error };
  const { domain, label, suffix } = parsed.value;
  const suffixes = selectedSuffixes(formData);
  if (suffixes.filter((s) => s !== suffix).length === 0) {
    return { ok: false, message: "Pilih minimal satu ekstensi lain untuk dipantau." };
  }
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 500) || null;

  const { data: dup } = await ctx.supabase.from("domains").select("id").eq("base_domain", domain).maybeSingle();
  if (dup) return { ok: false, message: `${domain} sudah ada di daftar domain Anda.` };

  const { data: created, error } = await ctx.supabase
    .from("domains")
    .insert({ base_domain: domain, label, suffix, notes })
    .select("id")
    .single();
  if (error || !created) {
    if (error?.code === "23505") return { ok: false, message: `${domain} sudah ada di daftar domain Anda.` };
    return { ok: false, message: `Gagal menyimpan domain: ${error?.message ?? "kesalahan tidak diketahui"}` };
  }

  // If this domain was already monitored as another domain's variant, it is now known to be yours.
  await ctx.supabase.from("monitored_domains").update({ is_mine: true }).eq("fqdn", domain);

  const { added, skipped } = await syncVariants(ctx, created.id, label, suffix, suffixes);
  revalidatePath("/", "layout");
  const skippedNote = skipped.length
    ? ` ${skipped.join(", ")} dilewati karena sudah dipantau di domain lain.`
    : "";
  return {
    ok: true,
    message: `${domain} ditambahkan dengan ${added} varian. Pengecekan pertama berjalan pada jadwal harian berikutnya, atau tekan "Cek sekarang".${skippedNote}`,
    data: { id: created.id },
  };
}

export async function updateDomain(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await owner();
  const id = uuid(formData.get("id"));
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 500) || null;
  const isActive = formData.get("is_active") === "on";
  const suffixes = selectedSuffixes(formData);

  const { data: domain, error } = await ctx.supabase
    .from("domains")
    .update({ notes, is_active: isActive })
    .eq("id", id)
    .select("id, label, suffix")
    .single();
  if (error || !domain) return { ok: false, message: "Domain tidak ditemukan." };

  await ctx.supabase.from("monitored_domains").update({ is_active: isActive }).eq("domain_id", id);

  const { data: variants } = await ctx.supabase.from("monitored_domains").select("id, suffix").eq("domain_id", id);
  const current = new Set((variants ?? []).map((v) => v.suffix as string));
  const toRemove = (variants ?? []).filter((v) => !suffixes.includes(v.suffix as string)).map((v) => v.id as string);
  if (toRemove.length > 0) {
    await ctx.supabase.from("monitored_domains").delete().in("id", toRemove);
  }
  const { added, skipped } = await syncVariants(
    ctx,
    id,
    domain.label as string,
    domain.suffix as string,
    suffixes.filter((s) => !current.has(s)),
  );
  revalidatePath("/", "layout");
  const parts = ["Perubahan disimpan."];
  if (added) parts.push(`${added} ekstensi ditambahkan.`);
  if (toRemove.length) parts.push(`${toRemove.length} ekstensi dihapus dari pemantauan.`);
  if (skipped.length) parts.push(`${skipped.join(", ")} dilewati karena sudah dipantau di domain lain.`);
  return { ok: true, message: parts.join(" ") };
}

export async function deleteDomain(formData: FormData) {
  const ctx = await owner();
  const id = uuid(formData.get("id"));
  await ctx.supabase.from("domains").delete().eq("id", id);
  revalidatePath("/", "layout");
  redirect("/domains");
}

export async function setVariantMine(formData: FormData) {
  const ctx = await owner();
  const id = uuid(formData.get("id"));
  const value = formData.get("value") === "true";
  await ctx.supabase.from("monitored_domains").update({ is_mine: value }).eq("id", id);
  revalidatePath("/", "layout");
}

export async function setVariantActive(formData: FormData) {
  const ctx = await owner();
  const id = uuid(formData.get("id"));
  const value = formData.get("value") === "true";
  await ctx.supabase.from("monitored_domains").update({ is_active: value }).eq("id", id);
  revalidatePath("/", "layout");
}

export async function markNotificationRead(formData: FormData) {
  const ctx = await owner();
  const id = uuid(formData.get("id"));
  await ctx.supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
  revalidatePath("/", "layout");
}

export async function markAllNotificationsRead() {
  const ctx = await owner();
  await ctx.supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  revalidatePath("/", "layout");
}

export async function saveTelegramSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await owner();
  const enabled = formData.get("telegram_enabled") === "on";
  const chatId = String(formData.get("telegram_chat_id") ?? "").trim();
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
    return { ok: false, message: "Chat ID harus berupa angka (boleh diawali tanda minus untuk grup)." };
  }
  if (enabled && !chatId) return { ok: false, message: "Isi Chat ID sebelum mengaktifkan Telegram." };
  const { error } = await ctx.supabase
    .from("app_settings")
    .update({ telegram_enabled: enabled, telegram_chat_id: chatId || null, updated_at: new Date().toISOString() })
    .eq("singleton", true);
  if (error) return { ok: false, message: `Gagal menyimpan: ${error.message}` };
  revalidatePath("/settings");
  return { ok: true, message: "Pengaturan Telegram disimpan." };
}

export async function saveDefaultSuffixes(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await owner();
  const suffixes = selectedSuffixes(formData);
  if (suffixes.length === 0) return { ok: false, message: "Pilih minimal satu ekstensi." };
  const { error } = await ctx.supabase
    .from("app_settings")
    .update({ default_suffixes: suffixes, updated_at: new Date().toISOString() })
    .eq("singleton", true);
  if (error) return { ok: false, message: `Gagal menyimpan: ${error.message}` };
  revalidatePath("/", "layout");
  return { ok: true, message: "Ekstensi bawaan disimpan." };
}

export async function detectTelegramChats(): Promise<ActionState> {
  await owner();
  const token = telegramToken();
  if (!token) return { ok: false, message: "TELEGRAM_BOT_TOKEN belum diisi di Vercel." };
  if (!(await allowRequest("telegram:detect", 10, 10 * 60))) {
    return { ok: false, message: "Terlalu sering. Coba lagi beberapa menit lagi." };
  }
  const res = await findRecentChats(token);
  if (!res.ok) return { ok: false, message: res.error };
  if (res.chats.length === 0) {
    return {
      ok: false,
      message: "Belum ada pesan ke bot. Buka bot Anda di Telegram, tekan Start atau kirim pesan apa saja, lalu coba lagi.",
    };
  }
  return { ok: true, message: null, data: res.chats };
}

export async function sendTelegramTest(): Promise<ActionState> {
  const ctx = await owner();
  const token = telegramToken();
  if (!token) return { ok: false, message: "TELEGRAM_BOT_TOKEN belum diisi di Vercel." };
  if (!(await allowRequest("telegram:test", 5, 10 * 60))) {
    return { ok: false, message: "Terlalu banyak pesan uji. Coba lagi beberapa menit lagi." };
  }
  const { data } = await ctx.supabase.from("app_settings").select("telegram_chat_id").eq("singleton", true).single();
  const chatId = data?.telegram_chat_id as string | null;
  if (!chatId) return { ok: false, message: "Simpan Chat ID terlebih dahulu." };
  const res = await sendTelegramMessage(
    token,
    chatId,
    "✅ Pesan uji dari DomainWatch. Jika Anda menerima pesan ini, notifikasi Telegram sudah berfungsi.",
  );
  return res.ok
    ? { ok: true, message: "Pesan uji terkirim. Periksa Telegram Anda." }
    : { ok: false, message: res.error };
}
