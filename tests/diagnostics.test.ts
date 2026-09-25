import { describe, expect, it, vi } from "vitest";
import { checkPublicKey, describeSecretKeyCheck, projectRefOf } from "@/lib/supabase/diagnostics";

const URL_ = "https://abcd1234.supabase.co";
const KEY = "sb_publishable_secretlooking_value";

function fetchReturning(res: Response | Error) {
  return vi.fn<typeof fetch>(async () => {
    if (res instanceof Error) throw res;
    return res;
  });
}

const settings = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("Supabase self-check (/setup)", () => {
  it("reads the project ref from the URL only for supabase.co hosts", () => {
    expect(projectRefOf(URL_)).toBe("abcd1234");
    expect(projectRefOf("https://db.example.com")).toBeNull();
    expect(projectRefOf("not a url")).toBeNull();
  });

  it("confirms a matching publishable key and reports the auth settings", async () => {
    const fn = fetchReturning(settings({ external: { email: true }, disable_signup: true }));
    const lines = await checkPublicKey(`${URL_}/`, KEY, fn);
    expect(fn.mock.calls[0][0]).toBe(`${URL_}/auth/v1/settings`);
    expect((fn.mock.calls[0][1]?.headers as Record<string, string>).apikey).toBe(KEY);
    expect(fn.mock.calls[0][1]?.cache).toBe("no-store");
    expect(lines.map((l) => [l.tone, l.text])).toEqual([
      ["ok", "Kunci publik cocok dengan proyek Supabase"],
      ["ok", "Login dengan email aktif"],
      ["ok", "Pendaftaran akun baru dimatikan"],
    ]);
  });

  it("explains a disabled email provider and open sign-ups", async () => {
    const lines = await checkPublicKey(URL_, KEY, fetchReturning(settings({ external: { email: false }, disable_signup: false })));
    expect(lines.map((l) => l.tone)).toEqual(["ok", "error", "warning"]);
    expect(lines[1].hint).toMatch(/Sign In \/ Providers > Email/);
    expect(lines[2].hint).toMatch(/Allow new users to sign up/);
  });

  it("maps a rejected key, an unreachable host and other answers", async () => {
    const wrongKey = await checkPublicKey(URL_, KEY, fetchReturning(new Response("{}", { status: 401 })));
    expect(wrongKey[0]).toMatchObject({ tone: "error", text: expect.stringMatching(/tidak cocok dengan proyek ini/) });

    const down = await checkPublicKey(URL_, KEY, fetchReturning(new TypeError("fetch failed")));
    expect(down[0]).toMatchObject({ tone: "error", text: "Tidak bisa menghubungi Supabase di alamat ini" });

    const other = await checkPublicKey(URL_, KEY, fetchReturning(new Response("", { status: 404 })));
    expect(other[0].text).toMatch(/HTTP 404/);

    for (const lines of [wrongKey, down, other]) expect(JSON.stringify(lines)).not.toContain(KEY);
  });

  it("maps the secret-key database read to status lines", () => {
    const text = (res: Parameters<typeof describeSecretKeyCheck>[0]) => describeSecretKeyCheck(res).map((l) => l.text);
    expect(text({ data: [{ singleton: true }], error: null, status: 200 })).toEqual([
      "Kunci rahasia valid dan skema database terpasang",
      "Akun pemilik sudah didaftarkan",
    ]);
    expect(text({ data: [], error: null, status: 200 })[1]).toBe("Akun pemilik belum didaftarkan");
    expect(text({ data: null, error: { message: "Invalid API key" }, status: 401 })[0]).toMatch(/tidak valid/);
    expect(text({ data: null, error: { message: "Could not find the table", code: "PGRST205" }, status: 404 })[0]).toBe(
      "Tabel belum ada: jalankan migrasi",
    );
    expect(text({ data: null, error: { message: "permission denied", code: "42501" }, status: 401 })[0]).toMatch(
      /tidak punya akses admin/,
    );
    expect(text({ data: null, error: { message: "TypeError: fetch failed", code: "" }, status: 0 })[0]).toMatch(
      /Tidak bisa menghubungi/,
    );
  });
});
