"use server";

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { allowRequest } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { error: string | null };

const TOO_MANY = "Terlalu banyak percobaan login. Tunggu 15 menit lalu coba lagi.";

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email dan kata sandi wajib diisi." };

  // Supabase only sees Vercel's server IP, so throttle per visitor IP and per
  // account here. The email is hashed so it is not stored in plain text.
  const emailKey = createHash("sha256").update(email).digest("hex").slice(0, 32);
  const [ipOk, emailOk] = await Promise.all([
    allowRequest(`login:ip:${await clientIp()}`, 10, 15 * 60),
    allowRequest(`login:email:${emailKey}`, 10, 15 * 60),
  ]);
  if (!ipOk || !emailOk) return { error: TOO_MANY };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.status === 429 || error.code === "over_request_rate_limit") return { error: TOO_MANY };
    // Same message for unknown email and wrong password.
    return { error: "Email atau kata sandi salah, atau akun belum dikonfirmasi." };
  }
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
