import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Applies the real migration to an embedded Postgres (PGlite) with a small
 * Supabase stand-in, then exercises RLS, constraints and server functions.
 */
const OWNER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

let db: PGlite;

async function as<T>(role: "anon" | "authenticated" | "service_role", sub: string | null, fn: () => Promise<T>) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub ?? ""}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync("tests/helpers/supabase-stub.sql", "utf8"));
  const migrations = ["0001_init.sql", "0002_hardening.sql"].map((f) =>
    readFileSync(`supabase/migrations/${f}`, "utf8"),
  );
  for (const m of migrations) await db.exec(m);
  for (const m of migrations) await db.exec(m); // must be re-runnable
  await db.exec(`insert into auth.users (id, email) values ('${OWNER}', 'owner@example.com'), ('${STRANGER}', 'x@example.com');`);
  await db.exec(readFileSync("supabase/setup-owner.sql", "utf8"));
}, 60_000);

describe("owner setup", () => {
  it("registers the owner by email", async () => {
    const r = await db.query<{ user_id: string }>("select user_id from public.app_owner");
    expect(r.rows).toEqual([{ user_id: OWNER }]);
  });
});

describe("row level security", () => {
  it("lets the owner create and read domains and variants (data persists across sessions)", async () => {
    await as("authenticated", OWNER, async () => {
      await db.exec(
        `insert into public.domains (base_domain, label, suffix) values ('examplebrand.com', 'examplebrand', 'com');`,
      );
      await db.exec(`insert into public.monitored_domains (domain_id, fqdn, suffix)
        select id, 'examplebrand.net', 'net' from public.domains where base_domain = 'examplebrand.com';`);
    });
    const rows = await as("authenticated", OWNER, () =>
      db.query<{ fqdn: string; status: string; owner_id: string }>("select fqdn, status, owner_id from public.monitored_domains"),
    );
    expect(rows.rows).toEqual([{ fqdn: "examplebrand.net", status: "not_checked", owner_id: OWNER }]);
  });

  it("hides all data from a signed-in user who is not the owner", async () => {
    const r = await as("authenticated", STRANGER, () => db.query("select * from public.monitored_domains"));
    expect(r.rows).toHaveLength(0);
    const d = await as("authenticated", STRANGER, () => db.query("select * from public.domains"));
    expect(d.rows).toHaveLength(0);
    const s = await as("authenticated", STRANGER, () => db.query("select * from public.app_settings"));
    expect(s.rows).toHaveLength(0);
  });

  it("prevents a non-owner from inserting or deleting", async () => {
    await expect(
      as("authenticated", STRANGER, () =>
        db.exec(`insert into public.domains (base_domain, label, suffix) values ('evil.com','evil','com')`),
      ),
    ).rejects.toThrow(/row-level security/);
    await as("authenticated", STRANGER, () => db.exec(`delete from public.domains`));
    const left = await db.query("select * from public.domains");
    expect(left.rows).toHaveLength(1);
  });

  it("denies anonymous access entirely", async () => {
    await expect(as("anon", null, () => db.query("select * from public.domains"))).rejects.toThrow(/permission denied/);
    await expect(as("anon", null, () => db.query("select * from public.notifications"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("does not let the owner forge check results, events or run records", async () => {
    await expect(
      as("authenticated", OWNER, () =>
        db.exec(`insert into public.monitor_runs (trigger) values ('cron')`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as("authenticated", OWNER, () =>
        db.exec(`insert into public.status_events (monitored_domain_id, event_type, new_status, message, dedupe_key)
          select id, 'new_registration', 'registered', 'x', 'forged' from public.monitored_domains limit 1`),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets the owner write only the columns the app edits", async () => {
    // The columns written by src/app/(app)/actions.ts.
    await as("authenticated", OWNER, async () => {
      await db.exec(`insert into public.domains (base_domain, label, suffix, notes) values ('columns.com', 'columns', 'com', 'n')`);
      await db.exec(`update public.domains set notes = 'note', is_active = true where base_domain = 'columns.com'`);
      await db.exec(`insert into public.monitored_domains (domain_id, fqdn, suffix, is_mine, is_active)
        select id, 'columns.net', 'net', false, false from public.domains where base_domain = 'columns.com'`);
      await db.exec(`update public.monitored_domains set is_mine = true, is_active = true where fqdn = 'columns.net'`);
    });

    // Monitoring state and identity columns are server-only.
    for (const sql of [
      `update public.monitored_domains set status = 'registered'`,
      `update public.monitored_domains set claimed_until = '9999-12-31'`,
      `update public.monitored_domains set last_conclusive_status = 'unregistered', last_confirmed_unregistered_at = now()`,
      `update public.monitored_domains set baseline_status = 'unregistered'`,
      `update public.monitored_domains set fqdn = 'renamed.net'`,
      `update public.domains set base_domain = 'renamed.com'`,
      `insert into public.monitored_domains (domain_id, fqdn, suffix, status)
        select id, 'columns.org', 'org', 'registered' from public.domains where base_domain = 'columns.com'`,
    ]) {
      await expect(as("authenticated", OWNER, () => db.exec(sql)), sql).rejects.toThrow(/permission denied/);
    }

    const r = await db.query<{ status: string; is_mine: boolean; is_active: boolean; claimed_until: string | null }>(
      `select status, is_mine, is_active, claimed_until from public.monitored_domains where fqdn = 'columns.net'`,
    );
    expect(r.rows).toEqual([{ status: "not_checked", is_mine: true, is_active: true, claimed_until: null }]);
    await as("authenticated", OWNER, () => db.exec(`delete from public.domains where base_domain = 'columns.com'`));
    expect((await db.query(`select 1 from public.monitored_domains where fqdn = 'columns.net'`)).rows).toHaveLength(0);
  });

  it("denies TRUNCATE (which bypasses RLS) to API roles", async () => {
    await expect(as("authenticated", STRANGER, () => db.exec(`truncate public.app_settings cascade`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(as("authenticated", OWNER, () => db.exec(`truncate public.domains cascade`))).rejects.toThrow(
      /permission denied/,
    );
    const s = await db.query("select * from public.app_settings");
    expect(s.rows).toHaveLength(1);
  });

  it("denies authenticated users the server-only functions", async () => {
    await expect(
      as("authenticated", OWNER, () => db.query(`select public.hit_rate_limit('x', 1, 60)`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as("authenticated", OWNER, () => db.query(`select * from public.claim_due_domains(10, now(), 60)`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("ownership", () => {
  it("keeps monitoring data when an old owner account is deleted", async () => {
    const OLD = "33333333-3333-3333-3333-333333333333";
    await db.exec(`insert into auth.users (id, email) values ('${OLD}', 'old@example.com')`);
    await db.exec(`insert into public.domains (owner_id, base_domain, label, suffix) values ('${OLD}', 'keepme.com', 'keepme', 'com')`);
    await db.exec(`delete from auth.users where id = '${OLD}'`);
    const r = await db.query<{ owner_id: string | null }>(`select owner_id from public.domains where base_domain = 'keepme.com'`);
    expect(r.rows).toEqual([{ owner_id: null }]);
    await db.exec(`delete from public.domains where base_domain = 'keepme.com'`);
  });
});

describe("constraints and server functions", () => {
  it("prevents duplicate monitoring entries", async () => {
    await expect(
      db.exec(`insert into public.monitored_domains (owner_id, domain_id, fqdn, suffix)
        select '${OWNER}', id, 'examplebrand.net', 'net' from public.domains limit 1`),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.exec(`insert into public.domains (owner_id, base_domain, label, suffix) values ('${OWNER}','examplebrand.com','examplebrand','com')`),
    ).rejects.toThrow(/duplicate key/);
  });

  it("deduplicates status events by dedupe_key", async () => {
    const insert = `insert into public.status_events (monitored_domain_id, event_type, new_status, message, dedupe_key)
      select id, 'new_registration', 'registered', 'm', 'reg:test' from public.monitored_domains limit 1
      on conflict (dedupe_key) do nothing returning id`;
    const first = await as("service_role", null, () => db.query(insert));
    const second = await as("service_role", null, () => db.query(insert));
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);
  });

  it("allows only one monitor lock holder at a time", async () => {
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const q = (run: string) =>
      as("service_role", null, () => db.query<{ ok: boolean }>(`select public.acquire_monitor_lock('${run}', 300) as ok`));
    expect((await q(a)).rows[0].ok).toBe(true);
    expect((await q(b)).rows[0].ok).toBe(false);
    await as("service_role", null, () => db.query(`select public.release_monitor_lock('${a}')`));
    expect((await q(b)).rows[0].ok).toBe(true);
    await as("service_role", null, () => db.query(`select public.release_monitor_lock('${b}')`));
  });

  it("claims due domains once until the claim expires", async () => {
    const claim = () =>
      as("service_role", null, () => db.query<{ fqdn: string }>(`select fqdn from public.claim_due_domains(10, now(), 120)`));
    expect((await claim()).rows.map((r) => r.fqdn)).toEqual(["examplebrand.net"]);
    expect((await claim()).rows).toHaveLength(0);
  });

  it("rate-limits within a window", async () => {
    const hit = () =>
      as("service_role", null, () => db.query<{ ok: boolean }>(`select public.hit_rate_limit('k', 2, 60) as ok`));
    expect((await hit()).rows[0].ok).toBe(true);
    expect((await hit()).rows[0].ok).toBe(true);
    expect((await hit()).rows[0].ok).toBe(false);
  });

  it("prunes rate-limit windows older than a day", async () => {
    await db.exec(`insert into public.rate_limits (key, window_start, hits) values ('stale', now() - interval '2 days', 3)`);
    await as("service_role", null, () => db.query(`select public.hit_rate_limit('fresh', 5, 60)`));
    const keys = (await db.query<{ key: string }>(`select key from public.rate_limits`)).rows.map((r) => r.key);
    expect(keys).not.toContain("stale");
    expect(keys).toEqual(expect.arrayContaining(["fresh", "k"]));
  });

  it("lets the owner mark a notification read but not rewrite it", async () => {
    await as("service_role", null, () =>
      db.exec(`insert into public.notifications (kind, title, body) values ('alert', 't', 'b')`),
    );
    await as("authenticated", OWNER, () => db.exec(`update public.notifications set read_at = now()`));
    const r = await db.query<{ read_at: string | null }>("select read_at from public.notifications");
    expect(r.rows[0].read_at).not.toBeNull();
    await expect(
      as("authenticated", OWNER, () => db.exec(`update public.notifications set body = 'changed'`)),
    ).rejects.toThrow(/permission denied/);
  });
});
