import { after, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { runMonitor } from "@/lib/monitor/engine";
import { MAX_CHAIN_DEPTH, productionDeps, triggerContinuation } from "@/lib/monitor/runtime";

export const dynamic = "force-dynamic";
// Vercel Hobby maximum. The engine stops claiming work well before this.
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Scheduled monitoring entry point (Vercel Cron, once per day) and
 * continuation entry point for remaining batches. Responds immediately and
 * does the work after the response, within this function's max duration.
 */
export async function GET(request: Request) {
  if (!isCronAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const depthParam = Number(url.searchParams.get("depth") ?? "0");
  const depth = Number.isInteger(depthParam) && depthParam >= 0 ? depthParam : 0;
  const chainParam = url.searchParams.get("chain");
  const chainId = chainParam && UUID_RE.test(chainParam) ? chainParam : null;

  if (depth > MAX_CHAIN_DEPTH) {
    return NextResponse.json({ error: "Continuation limit reached" }, { status: 400 });
  }

  after(async () => {
    const deps = productionDeps();
    const outcome = await runMonitor(deps, {
      trigger: depth > 0 ? "continuation" : "cron",
      chainId,
      depth,
      willContinue: depth < MAX_CHAIN_DEPTH,
    });
    console.log("DomainWatch monitor run", JSON.stringify(outcome));
    if (outcome.status === "partial" && outcome.remaining > 0 && outcome.checked > 0 && depth < MAX_CHAIN_DEPTH) {
      await triggerContinuation(chainId ?? outcome.runId, depth + 1);
    }
  });

  return NextResponse.json({ accepted: true, depth }, { status: 202 });
}
