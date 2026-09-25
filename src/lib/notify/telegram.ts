export type TelegramResult = { ok: true } | { ok: false; error: string };

const API = "https://api.telegram.org";

export function telegramToken(): string | null {
  const t = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return t ? t : null;
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramResult> {
  try {
    const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (res.ok && body?.ok) return { ok: true };
    return { ok: false, error: `Telegram menolak pesan: ${body?.description ?? `HTTP ${res.status}`}` };
  } catch {
    return { ok: false, error: "Gagal menghubungi server Telegram." };
  }
}

/** Find chat IDs of people who recently messaged the bot (for setup). */
export async function findRecentChats(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; chats: { id: string; name: string }[] } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`${API}/bot${token}/getUpdates?limit=50`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: { message?: { chat?: { id: number; first_name?: string; username?: string; title?: string } } }[];
    } | null;
    if (!res.ok || !body?.ok) {
      return { ok: false, error: `Telegram menolak permintaan: ${body?.description ?? `HTTP ${res.status}`}` };
    }
    const seen = new Map<string, string>();
    for (const u of body.result ?? []) {
      const c = u.message?.chat;
      if (c) seen.set(String(c.id), c.title ?? c.username ?? c.first_name ?? String(c.id));
    }
    return { ok: true, chats: [...seen].map(([id, name]) => ({ id, name })) };
  } catch {
    return { ok: false, error: "Gagal menghubungi server Telegram." };
  }
}
