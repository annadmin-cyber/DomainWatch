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
            │                        10 s timeout, 1 retry on timeout/5xx/429
            ├─ decideTransition()   baseline / change detection (pure function)
            ├─ status_events → notifications → notification_deliveries (idempotent)
            └─ remaining work? → continuation request to itself (max 10 per chain)
```

### Registration statuses

| Status | Meaning |
| --- | --- |
| `registered` | The registry's RDAP server returned the domain object. |
| `unregistered` | The registry's RDAP server answered "not found" (HTTP 404, non-HTML). This does **not** guarantee the name can be bought (premium, reserved, redemption period…). |
| `unknown` | Timeout, rate limit, 5xx, network error, invalid or mismatching response. Never treated as unregistered. |
| `unsupported` | No RDAP server for the TLD in the IANA bootstrap registry. |
| `not_checked` | Not checked yet. |

DNS records and websites are never used to infer registration.

### Baselines and alerts

- The first conclusive check (`registered`/`unregistered`) becomes the baseline. A variant already registered at that time is labelled "Sudah terdaftar saat pemantauan dimulai" (already registered when monitoring started) and never alerts for that.
- A `registered` result whose last conclusive status was `unregistered` is re-checked (second lookup after 3 s). Only if both agree is an event created.
  - Previous check was a conclusive `unregistered` → `new_registration` ("… sekarang terdaftar. Sebelumnya dikonfirmasi belum terdaftar pada … Perubahan terdeteksi pada …").
  - Checks in between were `unknown` → `newly_detected_registered` ("baru terdeteksi sebagai terdaftar"), not described as a proven new registration.
- Detection time is stored separately from the registration date (the latter only when RDAP provides it). Registrant identity is never shown or guessed.
- Variants marked "milik saya" (mine) record an `own_domain_change` event but never alert.
- Idempotency: each event has a `dedupe_key` (`reg:<variant>:<last confirmed unregistered time>`) with a unique constraint; notifications are unique per event; deliveries are unique per notification + channel and move `pending → sending → sent/failed` atomically (at most 3 attempts, never re-sent once `sending`).

### Data source: RDAP

| | |
| --- | --- |
| Provider | Registry RDAP servers found through the IANA bootstrap file `https://data.iana.org/rdap/dns.json` (RFC 9224). A snapshot is bundled as fallback. |
| API key | None. |
| Cost | Free. |
| Limits | Each registry sets its own, mostly unpublished, rate limits. DomainWatch spaces requests ≥1 s per registry host and runs once a day. |
| Supported (IANA registry of 2026-09-16) | `.com .net .org .id` (incl. `.co.id .my.id .web.id .biz.id .or.id` via PANDI) `.app .dev .online .store .site .tech .xyz .biz .info .shop` and others listed by IANA. |
| Not supported | `.co`, `.io`, `.me` had no RDAP server in the IANA registry at that date. They show as "Tidak didukung". Support is re-evaluated at runtime from the live IANA file, so they start working automatically if their registries are added. |

Provider code lives in `src/lib/providers/` behind the `LookupProvider` interface; the monitor engine only depends on that interface, so a paid WHOIS/RDAP API can be added later for unsupported TLDs.

### Capacity on Vercel Hobby

- Cron: once per day, timing precision ±59 min (Hobby limit). Schedule `0 1 * * *` = 08:00–08:59 WIB.
- Function duration: Hobby max 300 s. A run stops claiming work after ~210 s (240 s budget, 30 s reserve).
- Rough throughput: with 4 parallel lookups and ~1 s per lookup, one invocation checks roughly 300–600 variants when registries respond quickly. Continuations add up to 10 more invocations per day. Realistically, plan for **up to ~50 main domains × 10 extensions (≈500 variants)** in the first version; the true limit depends on registry response times and rate limits (a slow registry slows only its own queue).
- Anything not checked within 26 h is shown as overdue on the dashboard.

### Security

- Only the single account registered in `public.app_owner` can use the app. Public sign-ups should be disabled in Supabase.
- Every page, server action and API route verifies the user with `supabase.auth.getUser()` and `is_owner()`; the proxy only refreshes the session and redirects.
- RLS: all tables require `is_owner()`. Monitoring tables (runs, checks, events, deliveries) are read-only for the owner; `anon` has no access at all. Lock, rate-limit and claim functions are callable only by `service_role`.
- `SUPABASE_SECRET_KEY`, `CRON_SECRET` and `TELEGRAM_BOT_TOKEN` are server-only (never `NEXT_PUBLIC_`).
- Cron endpoint requires `Authorization: Bearer $CRON_SECRET` (constant-time compare, min length 16).
- Manual checks are rate-limited in Postgres: 1 per variant per minute, 30 per 10 minutes overall, "check all" 2 per 15 minutes.

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

## Database

- `supabase/migrations/0001_init.sql` — schema, RLS policies, helper functions. Idempotent; paste into Supabase SQL Editor and run.
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
- `tests/rdap.test.ts` — RDAP classification with mocked HTTP (registered, 404, HTML 404, timeout, 429, 5xx, invalid JSON, mismatching name, unsupported TLDs).
- `tests/engine.test.ts` — baselines, single alert on confirmed transition, idempotency, confirmation re-check, provider errors, "newly detected" wording, own domains, locking, time-budget batching + continuation, Telegram delivery (mocked).
- `tests/routes.test.ts` — cron endpoint rejects missing/wrong secret; manual check endpoint rejects signed-out requests.
- `tests/database.test.ts` — applies the real migration to embedded Postgres (PGlite) with a minimal Supabase stand-in and checks RLS (owner vs. other user vs. anon), duplicate prevention, event dedupe, lock, claims, rate limit, notification column permissions.

All registration changes in tests come from a fixture provider; no real domains are registered or queried.

## Verifying the schedule in production

1. Vercel > Project > Settings > Cron Jobs shows `/api/cron/monitor` with `0 1 * * *`. The "Run" button there triggers it immediately.
2. Vercel > Project > Logs, filter by `/api/cron/monitor`: a `202` followed by a log line `DomainWatch monitor run {...}`.
3. In the app: Dashboard health card and Pengaturan > Riwayat pemantauan show runs of type "Terjadwal" with their status. The dashboard only shows "Pemantauan otomatis berjalan" when a scheduled run actually executed within the last 26 h.
