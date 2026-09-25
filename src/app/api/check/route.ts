import { after, NextResponse } from "next/server";
import { requireOwner, UnauthorizedError } from "@/lib/auth";
import { checkDomain, deliverPending, runMonitor } from "@/lib/monitor/engine";
import { productionDeps } from "@/lib/monitor/runtime";
import { allowRequest, type RateLimitResult } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Manual checks fail closed: when the limiter itself is unavailable, nothing runs. */
function rejectRequest(result: Exclude<RateLimitResult, "allowed">, limitedMessage: string) {
  if (result === "error") {
    return NextResponse.json(
      { error: "Batas pengecekan tidak bisa diperiksa karena database sedang bermasalah. Coba lagi nanti." },
      { status: 503 },
    );
  }
  return NextResponse.json({ error: limitedMessage }, { status: 429 });
}

/**
 * Manual "Cek sekarang". Owner only, rate limited.
 * Body: { "id": "<monitored variant id>" } or { "scope": "all" }.
 */
export async function POST(request: Request) {
  try {
    await requireOwner();
  } catch (err) {
    const status = err instanceof UnauthorizedError ? err.status : 401;
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unauthorized" }, { status });
  }

  let body: { id?: unknown; scope?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Permintaan tidak valid." }, { status: 400 });
  }

  if (body.scope === "all") {
    const limit = await allowRequest("manual:all", 2, 15 * 60);
    if (limit !== "allowed") {
      return rejectRequest(limit, "Cek semua hanya bisa dijalankan 2 kali per 15 menit. Coba lagi nanti.");
    }
    after(async () => {
      const outcome = await runMonitor(productionDeps(), { trigger: "manual", forceAll: true });
      console.log("DomainWatch manual run", JSON.stringify(outcome));
    });
    return NextResponse.json({ accepted: true }, { status: 202 });
  }

  if (typeof body.id !== "string" || !UUID_RE.test(body.id)) {
    return NextResponse.json({ error: "ID domain tidak valid." }, { status: 400 });
  }

  const limits = await Promise.all([
    allowRequest(`manual:one:${body.id}`, 1, 60),
    allowRequest("manual:one", 30, 10 * 60),
  ]);
  const blocked = limits.includes("error") ? "error" : limits.includes("limited") ? "limited" : null;
  if (blocked) {
    return rejectRequest(blocked, "Terlalu banyak pengecekan manual. Tunggu sebentar lalu coba lagi.");
  }

  const deps = productionDeps();
  const state = await deps.repo.claimOne(body.id, 90);
  if (!state) {
    return NextResponse.json(
      { error: "Domain ini sedang diperiksa oleh proses lain atau tidak ditemukan." },
      { status: 409 },
    );
  }
  try {
    // Manual checks run inside this request, so keep them well under maxDuration.
    const outcome = await checkDomain(deps, state, null, { deadline: Date.now() + 60_000 });
    if (outcome.deferred) {
      await deps.repo.releaseClaims([state.id]);
      return NextResponse.json({ error: "Waktu pengecekan habis sebelum dimulai. Coba lagi." }, { status: 503 });
    }
    after(() => deliverPending(deps).then(() => undefined));
    return NextResponse.json({ ok: true, status: outcome.status, event: outcome.event });
  } catch (err) {
    await deps.repo.releaseClaims([state.id]).catch(() => {});
    console.error("Manual check failed:", err);
    return NextResponse.json({ error: "Pengecekan gagal karena kesalahan server." }, { status: 500 });
  }
}
