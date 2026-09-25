# DomainWatch

Private domain monitoring. Add a domain you own (for example `examplebrand.com`) and DomainWatch watches the exact same name under other extensions (`.net`, `.org`, `.id`, `.co.id`, `.app`, `.store`, …). It alerts you when a variant changes from **confirmed unregistered** to **confirmed registered**.

- Next.js 16 (App Router, TypeScript) + Tailwind CSS 4
- Supabase Postgres + Supabase Auth, Row Level Security
- Vercel hosting + Vercel Cron (once a day)
- Registration data from official RDAP servers (no API key)
- In-app notification center, optional Telegram alerts
- UI in Indonesian

Beginner deployment guide (Indonesian): [DEPLOY-VERCEL.md](./DEPLOY-VERCEL.md).

## How it works

```
Vercel Cron (01:00 UTC daily)
  └─ GET /api/cron/monitor  (Authorization: Bearer CRON_SECRET)
       └─ runMonitor()  ── global lock (monitor_lock) so runs never overlap
            ├─ claim_due_domains()  batches of 20, rows claimed with a lease
            ├─ RdapProvider.lookup() 4 in parallel, ≥1 s between requests per registry host,
            │                        10 s timeout (not retried), 1 retry on 429/5xx/network error,
            │                        Retry-After applies to the whole host, circuit breaker
            │                        (3 consecutive failures → host skipped for the run), hard deadline
            ├─ decideTransition()   baseline / change detection (pure function); any flip of
            │                        the last conclusive status needs a confirming 2nd lookup
            ├─ status_events → notifications → notification_deliveries (idempotent)
            └─ remaining work? → continuation request to itself (max 10 per chain)
```

### Registration statuses

| Status | Meaning |
| --- | --- |
| `registered` | The registry's RDAP server returned the domain object. |
| `unregistered` | The registry's RDAP server answered "not found": HTTP 404 with an empty body or an RDAP JSON error. Other 404 pages (HTML, plain text, generic gateway JSON) count as `unknown`. This does **not** guarantee the name can be bought (premium, reserved, redemption period…). |
| `unknown` | Timeout, rate limit, 5xx, network error, invalid or mismatching response. Never treated as unregistered. |
| `unsupported` | No RDAP server for the TLD in the IANA bootstrap registry. |
| `not_checked` | Not checked yet. |

DNS records and websites are never used to infer registration.

### Baselines and alerts

- The first conclusive check (`registered`/`unregistered`) becomes the baseline. A variant already registered at that time is labelled "Sudah terdaftar saat pemantauan dimulai" (already registered when monitoring started) and never alerts for that.
- Any conclusive result that differs from the last conclusive status (`unregistered → registered` or `registered → unregistered`) is re-checked (second lookup after 3 s). Only if both agree is the change accepted; otherwise the check is recorded as `unknown`. A single spurious 404 therefore cannot re-arm a false alert.
  - Previous check was a conclusive `unregistered` within the last 30 h → `new_registration` ("… sekarang terdaftar. Sebelumnya dikonfirmasi belum terdaftar pada … Perubahan terdeteksi pada …").
  - Checks in between were `unknown`, or the last confirmation is older than 30 h → `newly_detected_registered` ("baru terdeteksi sebagai terdaftar"), not described as a proven new registration.
- Detection time is stored separately from the registration date (the latter only when RDAP provides it). Registrant identity is never shown or guessed.
- Variants marked "milik saya" (mine) record an `own_domain_change` event but never alert.
- Idempotency: each event has a `dedupe_key` (`reg:<variant>:<last confirmed unregistered time>`) with a unique constraint; notifications are unique per event; deliveries are unique per notification + channel. Event → notification → delivery are written before the domain state is updated, and each step returns the existing row on conflict, so a check that fails midway is completed by the next run without duplicates.
- Telegram deliveries move `pending → sending → sent/failed` with a compare-and-set claim (at most 3 attempts). A delivery left in `sending` for 10 minutes (the worker died mid-send) is retried, so in that rare case a message can arrive twice rather than never.

### Data source: RDAP

| | |
| --- | --- |
| Provider | Registry RDAP servers found through the IANA bootstrap file `https://data.iana.org/rdap/dns.json` (RFC 9224), cached for 12 h. If a refresh fails, the previous live copy is kept; only without any live copy is a bundled snapshot used, and TLDs missing from it are then reported as `unknown`, not `unsupported`. |
| API key | None. |
| Cost | Free. |
| Limits | Each registry sets its own, mostly unpublished, rate limits. DomainWatch spaces requests ≥1 s per registry host and runs once a day. |
| Supported (IANA registry of 2026-09-16) | `.com .net .org .id` (incl. `.co.id .my.id .web.id .biz.id .or.id` via PANDI) `.app .dev .online .store .site .tech .xyz .biz .info .shop` and others listed by IANA. |
| Not supported | `.co`, `.io`, `.me` had no RDAP server in the IANA registry at that date. They show as "Tidak didukung". Support is re-evaluated at runtime from the live IANA file, so they start working automatically if their registries are added. |

Provider code lives in `src/lib/providers/` behind the `LookupProvider` interface; the monitor engine only depends on that interface, so a paid WHOIS/RDAP API can be added later for unsupported TLDs.

### Capacity on Vercel Hobby

- Cron: once per day, timing precision ±59 min (Hobby limit). Schedule `0 1 * * *` = 08:00–08:59 WIB.
- Function duration: Hobby max 300 s. A run starts no new check after 200 s, no registry request after 250 s, stops Telegram delivery at 285 s, and always records its outcome and releases the lock.
- A variant is due again 3 h after its last check, so manual checks during the day never make the next daily run skip it.
- Rough throughput: with 4 parallel lookups and ~1 s per lookup, one invocation checks roughly 250–500 variants when registries respond quickly. Continuations add up to 10 more invocations per day. Realistically, plan for **up to ~50 main domains × 10 extensions (≈500 variants)** in the first version; the true limit depends on registry response times and rate limits.
- The 4 workers are shared by all registries, so a slow or failing registry can occupy them while its per-host queue drains. To bound that, timeouts are not retried (only 429, 5xx and network errors get one retry), a `Retry-After` from one 429 pauses every lookup on that host, and a per-host circuit breaker skips a registry for the rest of the run after 3 consecutive failures. Its remaining variants are shown as `unknown` and checked again on the next run.
- A lookup that cannot start before the run's hard deadline is not recorded; the variant stays due and the continuation run checks it.
- `vercel.json` pins functions to region `sin1` (Singapore, next to the Supabase project recommended in the guide) and enables fluid compute, which Hobby needs for the 300 s `maxDuration`.
- Anything not checked within 26 h is shown as overdue on the dashboard, and a variant without a conclusive result (`registered`/`unregistered`) in 26 h is flagged even if it was checked.

### Security

- Only the single account registered in `public.app_owner` can use the app. Public sign-ups should be disabled in Supabase.
- Every page, server action and API route verifies the user with `supabase.auth.getUser()` and `is_owner()`; the proxy only refreshes the session and redirects (if Supabase is unreachable it treats the visitor as signed out instead of failing every page).
- RLS: all tables require `is_owner()`. Monitoring tables (runs, checks, events, deliveries) are read-only for the owner; `anon` has no access at all. Lock, rate-limit and claim functions are callable only by `service_role`.
- Column-level privileges: through the Data API the owner may only insert/update the columns the app edits (`domains`: `base_domain, label, suffix, notes` / `notes, is_active`; `monitored_domains`: `domain_id, fqdn, suffix, is_mine, is_active` / `is_mine, is_active`). Monitoring state (`status`, `last_*`, `baseline_*`, `claimed_until`, …) is written by the server only.
- `SUPABASE_SECRET_KEY`, `CRON_SECRET` and `TELEGRAM_BOT_TOKEN` are server-only (never `NEXT_PUBLIC_`).
- Cron endpoint requires `Authorization: Bearer $CRON_SECRET` (constant-time compare, min length 16).
- Manual checks are rate-limited in Postgres: 1 per variant per minute, 30 per 10 minutes overall, "check all" 2 per 15 minutes. If the limiter itself is unavailable, manual checks are refused (fail closed).
- Login is rate-limited in Postgres per visitor IP, then per (hashed) email: 10 attempts per 15 minutes each. Supabase itself only sees Vercel's server IP. If the limiter itself is unavailable, login is still allowed (fail open, logged) so a database hiccup cannot lock the owner out.

## Environment variables

| Name | Purpose | Required | Where to get it | Where to enter it | Secret? |
| --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Yes | Supabase > Project Settings > Data API (Project URL) | Vercel > Project > Settings > Environment Variables | No, public |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser/server key for user sessions (RLS applies) | Yes | Supabase > Project Settings > API Keys > Publishable key (`sb_publishable_…`) | Vercel env vars | No, public |
| `SUPABASE_SECRET_KEY` | Server key for background monitoring (bypasses RLS) | Yes | Supabase > Project Settings > API Keys > Secret key (`sb_secret_…`; legacy `service_role` also works) | Vercel env vars | **Yes** |
| `CRON_SECRET` | Authenticates Vercel Cron and continuation calls | Yes | Create a random string ≥ 16 chars (e.g. a password generator) | Vercel env vars | **Yes** |
| `TELEGRAM_BOT_TOKEN` | Sends Telegram alerts | No | Telegram @BotFather `/newbot` | Vercel env vars | **Yes** |
| `APP_URL` | Base URL for continuation runs | No (defaults to `VERCEL_PROJECT_PRODUCTION_URL`) | Your production URL | Vercel env vars | No |

The Telegram chat ID is not an environment variable; it is saved in the app (Pengaturan).

- In Vercel's form, choose type **Config** for the two `NEXT_PUBLIC_` variables (keep the prefix even if Vercel suggests removing it) and **Secret/Sensitive** for `SUPABASE_SECRET_KEY`, `CRON_SECRET` and `TELEGRAM_BOT_TOKEN`. Redeploy after every change: `NEXT_PUBLIC_` values are read at build time.
- `APP_URL` must be the final production URL that does not redirect (for example the `www.` host when the bare domain redirects to it): continuation requests do not follow redirects, because a redirect would drop their `Authorization` header. `https://` is added when missing.
- `/setup` lists which variables are set or invalid and runs a live connection self-check: whether the publishable key matches the project, whether email login is enabled and public sign-ups are disabled, whether the secret key works and the schema is installed, whether an owner is registered, and the project ref to compare with the Supabase dashboard URL. It never shows key values.

## Database

- `supabase/migrations/0001_init.sql` — schema, RLS policies, helper functions.
- `supabase/migrations/0002_hardening.sql` — explicit grants, column-level insert/update privileges for the owner on `domains` and `monitored_domains`, no TRUNCATE/TRIGGER for API roles, `owner_id` set to NULL (not cascaded) when an old owner account is deleted, and `hit_rate_limit()` prunes rate-limit windows older than a day.
- Run all migrations in order in the Supabase SQL Editor. Each file is idempotent.
- `supabase/setup-owner.sql` — registers the owner account (edit the email first).

Tables: `app_owner`, `domains`, `monitored_domains`, `check_results`, `status_events`, `notifications`, `notification_deliveries`, `monitor_runs`, `app_settings`, `monitor_lock`, `rate_limits`.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000
npm run typecheck
npm run lint
npm test
npm run build
```

Trigger a monitoring run locally:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/monitor
```

## Tests

`npm test` runs:

- `tests/parse.test.ts` — domain parsing with the Public Suffix List (`.co.id`, subdomains, IPs).
- `tests/rdap.test.ts` — RDAP classification with mocked HTTP (registered, RDAP vs. non-RDAP 404, HTML 404, timeout incl. body timeout, 429 with Retry-After per host and as HTTP date, 5xx, circuit breaker, deadline, invalid JSON, mismatching name, unsupported TLDs) and the IANA bootstrap cache (stale live copy kept, shared request, snapshot fallback).
- `tests/engine.test.ts` — baselines, single alert on confirmed transition, idempotency, confirmation re-check, provider errors, "newly detected" wording, own domains, locking, time-budget batching + continuation, deferred lookups, Telegram delivery (mocked).
- `tests/routes.test.ts` — cron endpoint rejects missing/wrong secret; manual check endpoint rejects signed-out requests.
- `tests/login.test.ts` — login error messages, IP-then-email rate limiting, fail-open login and fail-closed manual checks when the limiter is down, redirect to `/setup`.
- `tests/config.test.ts` — `APP_URL` normalisation, Supabase URL validation, continuation requests without redirects, proxy behaviour when Supabase fails, paged reads past the 1000-row cap, dashboard health.
- `tests/diagnostics.test.ts` — the `/setup` connection self-check (mocked HTTP).
- `tests/database.test.ts` — applies the real migrations (twice) to embedded Postgres (PGlite) with a minimal Supabase stand-in and checks RLS (owner vs. other user vs. anon), column-level privileges, duplicate prevention, event dedupe, lock, claims, rate limit and its pruning, notification column permissions.

All registration changes in tests come from a fixture provider; no real domains are registered or queried.

## Verifying the schedule in production

1. Vercel > Project > Settings > Cron Jobs shows `/api/cron/monitor` with `0 1 * * *`. The "Run" button there triggers it immediately, but that only proves the endpoint works: it is recorded as "Terjadwal" too.
2. Vercel > Project > Logs, filter by `/api/cron/monitor`: a `202` followed by a log line `DomainWatch monitor run {...}`.
3. To confirm the schedule itself, do not press "Run" and check the next day: Pengaturan > Riwayat pemantauan must show a new "Terjadwal" run whose start time ("Mulai") is between 08.00 and 09.00 WIB. From then on the dashboard shows "Pemantauan otomatis berjalan" only while a scheduled run executed within the last 26 h.
