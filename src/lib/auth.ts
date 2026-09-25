import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type OwnerContext = {
  userId: string;
  email: string | null;
  supabase: Awaited<ReturnType<typeof createClient>>;
};

/**
 * Verifies the signed-in user against Supabase Auth and the app_owner table.
 * Returns null when not signed in or not the registered owner.
 */
export async function getOwner(): Promise<{ owner: OwnerContext | null; signedIn: boolean }> {
  const supabase = await createClient();
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData.user) return { owner: null, signedIn: false };
  const { data: isOwner } = await supabase.rpc("is_owner");
  if (isOwner !== true) return { owner: null, signedIn: true };
  return {
    signedIn: true,
    owner: { userId: userData.user.id, email: userData.user.email ?? null, supabase },
  };
}

/** For pages: redirect to /login or /denied when the visitor is not the owner. */
export async function requireOwnerPage(): Promise<OwnerContext> {
  const { owner, signedIn } = await getOwner();
  if (!owner) redirect(signedIn ? "/denied" : "/login");
  return owner;
}

export class UnauthorizedError extends Error {
  constructor(public status: 401 | 403) {
    super(status === 401 ? "Anda harus login terlebih dahulu." : "Akun ini tidak memiliki akses ke DomainWatch.");
  }
}

/** For server actions and route handlers. */
export async function requireOwner(): Promise<OwnerContext> {
  const { owner, signedIn } = await getOwner();
  if (!owner) throw new UnauthorizedError(signedIn ? 403 : 401);
  return owner;
}
