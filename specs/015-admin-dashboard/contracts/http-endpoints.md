# Contract — F9 HTTP Endpoints

**Branch**: `015-admin-dashboard` | **Date**: 2026-05-25

F9 is primarily server-rendered (App Router pages + server actions calling the
Application use-cases). The only new **route handlers** are the cron triggers and the
private-artefact download proxy. All are tenant-scoped; cron routes use Bearer
`CRON_SECRET` (`verifyCronBearer`, constant-time); the download proxy uses session auth
+ a signed token.

---

## Server-rendered pages (no public API; call use-cases server-side)

| Route | Portal | Story | Access |
|-------|--------|-------|--------|
| `/admin` | staff | US1 | admin (full) / manager (finance-redacted); member → redirected to portal |
| `/admin/audit` | staff | US2 | admin / manager (redacted); member → forbidden |
| `/admin/directory` | staff | US5 | admin / manager |
| `/admin/members/[memberId]/timeline` | staff | US3 | admin / manager (redacted) |
| `/admin/members/[memberId]/benefits` | staff | US4 | admin / manager |
| `/portal/benefits` | member | US4 | member (own) |
| `/portal/timeline` | member | US3 | member (own, redacted) |
| `/portal/account/data-export` | member | US6 | member (own) |

Mutations (dismiss insight, update directory listing, request export, generate E-Book)
are **server actions** invoking the use-cases above; CSRF Origin allow-list +
session checks per existing middleware.

---

## Timeline JSON (keyset load-more) endpoints — US3

The timeline pages SSR the first page; the virtualized client stream fetches
subsequent pages from these JSON endpoints. Both accept the same query params
and return `{ items[], next_cursor, total }` (items carry `source`, `event_type`,
`actor_kind`, `actor_user_id`, `actor_display_name`, `payload`).

| Endpoint | Access | Notes |
|----------|--------|-------|
| `GET /api/members/[memberId]/timeline` | staff (admin/manager) | pre-existing F3 route, **extended** with the US3 filters |
| `GET /api/portal/timeline` | member (own) | **new** — member derived from session (`findByLinkedUserId`), never from the URL (FR-017 own-history-only) |

Query params (all optional): `cursor` (opaque keyset), `limit` (1–100, default 50),
`source` (audit/invoice/payment/event/broadcast/renewal), `actorKind`
(staff/member/system), `from` & `to` (`YYYY-MM-DD`, tenant-tz calendar days →
UTC bounds; malformed → 400 `validation_error`). Member-role responses are
payload-redacted (FR-017).

---

## Cron endpoints (Bearer `CRON_SECRET`, retry-OFF, cron-job.org)

### `POST /api/cron/insights/snapshot-refresh-coordinator`
- Fans out over tenants; for each, calls the per-tenant route (or enqueues). Prioritises
  rows where `dashboard_metrics_cache.stale = true`. Cadence: every ~5 min.
- Auth: `gateCronBearerOrRespond`. Returns `{ refreshed: n, skipped: n }`.

### `POST /api/cron/insights/snapshot-refresh/[tenantId]`
- Runs `computeDashboardSnapshot` for one tenant inside `runInTenant`. Idempotent.
- Emits `insights.snapshot_refresh_duration_ms` + sets `snapshot_age_seconds`.

### `POST /api/cron/insights/process-export-jobs`
- Claims `requested` export jobs (per-(tenant,job) advisory lock), runs
  `processExportJob`, advances state machine. Also performs: (a) the TTL sweep
  (`ready|delivered → expired`, deletes private Blob object); and (b) the
  **stuck-`processing` reclaim** (Critique E2) — jobs claimed longer ago than a timeout
  are routed `processing → failed` (or `→ requested` within a bounded retry count).
  Cadence: every ~2–5 min.
- Emits `export_job_queue_depth` (gauge) + `export_job_duration_ms` (histogram by kind)
  + `export_job_reclaimed` (counter).

All cron routes: Node runtime; reject non-Bearer with rate-limited 401 + audit.

---

## Private artefact download proxy

### `GET /api/internal/exports/[jobId]/download?token=<signed>`
- **Auth (defence in depth)**:
  1. Valid session required.
  2. Caller MUST be the subject member **or** an admin of the same tenant (RBAC).
  3. `token` is a short-lived (≤ 1 h) HMAC (`EXPORT_DOWNLOAD_TOKEN_SECRET`) bound to
     `jobId`; verified constant-time against `export_jobs.download_token_hash`; rejected
     if past `expires_at`. The token is **single-use** (Critique E4) — invalidated on
     first successful download; a re-download requires a fresh authenticated request
     that mints a new token.
- On success: streams the **private** Blob (URL never exposed to client); transitions
  `ready → delivered`, invalidates the token; emits `data_export_downloaded`.
- Failure modes (each explicit, no silent fallback):
  - `401` no session · `403` wrong subject/tenant · `410` expired/swept ·
    `404` unknown job · `409` job not `ready`.
- Node runtime; `Cache-Control: private, no-store`.

---

## New environment variables (validated in `src/lib/env.ts` at boot)

| Var | Purpose |
|-----|---------|
| `FEATURE_F9_DASHBOARD` | kill-switch (default `false`); ships dark |
| `EXPORT_DOWNLOAD_TOKEN_SECRET` | ≥32 bytes, distinct from auth/unsubscribe secrets; signs download tokens |
| `CRON_SECRET` | reused (cron Bearer) |
| `BLOB_READ_WRITE_TOKEN` | reused (now also private-mode writes) |

---

## cron-job.org coordinators (ship-day operator gate)

| Schedule | Endpoint | Notes |
|----------|----------|-------|
| `*/5 * * * *` | `snapshot-refresh-coordinator` | dashboard freshness (R1) |
| `*/5 * * * *` | `process-export-jobs` | async E-Book + GDPR worker + TTL sweep |

Documented in `docs/runbooks/cron-jobs.md` (append F9 section). Retry OFF (idempotent
claims). Bearer `CRON_SECRET`.
