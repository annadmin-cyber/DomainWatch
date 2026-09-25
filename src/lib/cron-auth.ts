import { timingSafeEqual } from "node:crypto";

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 * Rejects when the secret is missing, too short, or does not match.
 */
export function isCronAuthorized(authorization: string | null, secret = process.env.CRON_SECRET): boolean {
  const expected = secret?.trim();
  if (!expected || expected.length < 16 || !authorization) return false;
  const given = Buffer.from(authorization);
  const want = Buffer.from(`Bearer ${expected}`);
  return given.length === want.length && timingSafeEqual(given, want);
}
