"use server";

import { createHash } from "node:crypto";
import type { AuthError } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { missingRequiredConfig } from "@/lib/env";
import { allowRequest } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error: string | null };

const TOO_MANY = "Terlalu banyak percobaan login. Tunggu 15 menit lalu coba lagi.";

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Indonesian message for a failed sign-in. Never logs the email or password. */
function signInErrorMessage(error: AuthError): string {
  if (error.status === 429 || error.code === "over_request_rate_limit") return TOO_MANY;
  if (error.code === "invalid_credentials" || error.code === "validation_failed" || (error.status === 400 && !error.code)) {
    // Same message for unknown email and wrong password.
    return "Email atau kata sandi salah, atau akun belum dikonfirmasi.";
  }
  // Supabase only reports this after the password was verified, so it does
  // not reveal which emails have an account.
  if (error.code === "email_not_confirmed") {
    return "Akun ini belum dikonfirmasi. Buka Supabase > Authentication > Users dan konfirmasi akun pemilik.";
  }
  if (error.code === "email_provider_disabled") {
    return (
      "Login dengan email dimatikan di Supabase. Buka Authentication > Sign In / Providers > Email dan aktifkan lagi. " +
      'Yang boleh dimatikan hanya "Allow new users to sign up".'
    );
  }
  console.error("Sign-in failed:", {
    code: error.code ?? null,
    status: error.status ?? null,
    name: error.name,
    message: error.message,
  });
  // Only the HTTP status and Supabase's fixed error code are shown, to help diagnose.
  const code = error.code && /^[a-z0-9_]{1,64}$/i.test(error.code) ? ` ${error.code}` : "";
  return (
    "Aplikasi tidak bisa terhubung ke Supabase, atau kunci Supabase di Vercel salah. Coba lagi sebentar lagi; " +
    "jika tetap gagal, periksa NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY di Vercel, " +
    `atau buka halaman /setup. (kode: ${error.status ?? 0}${code})`
  );
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (missingRequiredConfig().length > 0) redirect("/setup");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email dan kata sandi wajib diisi." };

  // Supabase only sees Vercel's server IP, so throttle per visitor IP and per
  // account here. The IP is checked first, so a blocked client never uses up
  // the account's bucket. The email is hashed so it is not stored in plain text.
  // If the limiter itself fails, login stays open (Supabase's own limits still
  // apply) so a database hiccup cannot lock the owner out.
  const byIp = await allowRequest(`login:ip:${await clientIp()}`, 10, 15 * 60);
  if (byIp === "limited") return { error: TOO_MANY };
  const emailKey = createHash("sha256").update(email).digest("hex").slice(0, 32);
  const byEmail = await allowRequest(`login:email:${emailKey}`, 10, 15 * 60);
  if (byEmail === "limited") return { error: TOO_MANY };
  if (byIp === "error" || byEmail === "error") console.error("Login rate limit unavailable; allowing the attempt.");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: signInErrorMessage(error) };
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
