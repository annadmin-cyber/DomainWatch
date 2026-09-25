"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Props = { id?: string; scope?: "all"; label?: string; className?: string };

/** Calls the protected /api/check endpoint and refreshes the page. */
export function CheckButton({ id, scope, label, className }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [, startTransition] = useTransition();

  async function onClick() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope === "all" ? { scope: "all" } : { id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMessage({ tone: "error", text: data.error ?? `Gagal (HTTP ${res.status}).` });
      } else if (scope === "all") {
        setMessage({
          tone: "ok",
          text: "Pengecekan semua domain dimulai di server. Muat ulang halaman dalam beberapa menit untuk melihat hasilnya.",
        });
      } else {
        setMessage({ tone: "ok", text: "Selesai dicek." });
      }
      startTransition(() => router.refresh());
    } catch {
      setMessage({ tone: "error", text: "Tidak bisa menghubungi server. Periksa koneksi internet Anda." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={onClick} disabled={busy} className={className ?? "btn-secondary"}>
        {busy ? "Mengecek…" : (label ?? "Cek sekarang")}
      </button>
      {message ? (
        <span className={`max-w-xs text-xs ${message.tone === "error" ? "text-red-700" : "text-emerald-700"}`}>
          {message.text}
        </span>
      ) : null}
    </span>
  );
}
