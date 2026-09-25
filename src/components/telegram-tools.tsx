"use client";

import { useState, useTransition } from "react";
import type { ActionState } from "@/app/(app)/actions";

export function TelegramTools({
  detect,
  test,
  tokenConfigured,
}: {
  detect: () => Promise<ActionState>;
  test: () => Promise<ActionState>;
  tokenConfigured: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionState | null>(null);

  function run(fn: () => Promise<ActionState>) {
    setResult(null);
    start(async () => {
      try {
        setResult(await fn());
      } catch {
        setResult({ ok: false, message: "Permintaan gagal. Coba lagi." });
      }
    });
  }

  const chats = Array.isArray(result?.data) ? (result.data as { id: string; name: string }[]) : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={pending || !tokenConfigured} onClick={() => run(detect)}>
          Cari Chat ID saya
        </button>
        <button type="button" className="btn-secondary" disabled={pending || !tokenConfigured} onClick={() => run(test)}>
          Kirim pesan uji
        </button>
      </div>
      {pending ? <p className="text-sm text-slate-500">Menghubungi Telegram…</p> : null}
      {result?.message ? (
        <p className={`text-sm ${result.ok ? "text-emerald-700" : "text-red-700"}`} role="status">
          {result.message}
        </p>
      ) : null}
      {chats.length > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="font-medium">Chat yang ditemukan (salin angka ke kolom Chat ID, lalu Simpan):</p>
          <ul className="mt-1 space-y-1">
            {chats.map((c) => (
              <li key={c.id}>
                <span className="font-mono">{c.id}</span> — {c.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
