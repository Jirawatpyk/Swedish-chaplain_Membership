# Runbook — External Cron Triggers (cron-job.org)

**Severity**: WARN (any individual job stalled > 30 min); ALARM (≥ 2 jobs simultaneously stalled)
**Owner**: Platform on-call
**Scope**: This file is the **index / configuration reference** for every
external cron trigger driving Chamber-OS. Per-job operational playbooks
(symptoms, on-call response) live in their own runbooks linked below.

## ⚡ Status (2026-07-17): MIGRATED to native Vercel Cron (Pro plan)

**As of 2026-07-17 SweCham is on the Vercel Pro plan and ALL cron jobs
below are driven by native Vercel Cron (`vercel.json` `crons`), not
cron-job.org.** cron-job.org is retained as a **paused standby** (do not
delete) per the completed migration in § "Migration path: Pro plan
(DONE — 2026-07-17)" at the bottom of this file — that section is the
authoritative `vercel.json` ↔ cron-job.org mapping, including the **UTC
schedule conversions** (Vercel Cron is UTC-only; the Asia/Bangkok jobs
use converted expressions).

Two facts drove the migration mechanics (both detailed in the mapping
section):

1. **Vercel Cron triggers each path with a GET request.** Handlers that
   previously exported only `POST` now also `export const GET = POST`
   (the same Bearer-gated body — no cron handler reads a request body).
   The shared `CRON_SECRET` Bearer gate is unchanged: Vercel
   auto-injects `Authorization: Bearer ${CRON_SECRET}` on every cron
   request when the env var is set.
2. **Vercel Cron schedules are UTC.** Jobs that ran on cron-job.org in
   the Asia/Bangkok timezone are shifted −7h into UTC (e.g. F8 dispatch
   06:00 ICT → `0 23 * * *`). The relative ordering of the F8 daily
   chain (dispatch → enter-awaiting → lapse → reconcile) is preserved
   because the whole chain shifts uniformly.

### Historical context (pre-2026-07-17, Hobby plan)

The SweCham deployment previously ran on Vercel Hobby, which
**rate-limits native `vercel.json` crons to once-per-day per project**.
Several features need 5-minute cadence (F5 stale-pending detection, F7
scheduled-broadcast dispatch, the outbox email dispatcher), so they were
triggered from [cron-job.org](https://cron-job.org) — 1-minute
granularity (free tier), Bearer-authenticated HTTP, email alerts on
consecutive failures, attempt-history for forensics. That constraint is
gone on Pro.

## Job catalogue

| Job | Endpoint | Cadence | Auth | Detail runbook |
|-----|----------|---------|------|----------------|
| F5 stale-pending-count | `GET /api/internal/metrics/stale-pending-count` | `*/5 * * * *` | `Authorization: Bearer ${CRON_SECRET}` | [stale-pending-count.md](./stale-pending-count.md) |
| F5 stale-refund sweep | `POST /api/cron/sweep-stale-pending-refunds` | `0 3 * * *` (native Vercel) | `Authorization: Bearer ${CRON_SECRET}` | [stale-pending-refund-sweep.md](./stale-pending-refund-sweep.md) |
| F4 outbox purge | `POST /api/cron/outbox-purge` | `15 20 * * *` (native Vercel) | `Authorization: Bearer ${CRON_SECRET}` | (in `vercel.json`) |
| F4 receipt-pdf reconcile | `POST /api/internal/cron/receipt-pdf-reconcile` | `30 3 * * *` (native Vercel) | `Authorization: Bearer ${CRON_SECRET}` | [receipt-pdf-permanently-failed.md](./receipt-pdf-permanently-failed.md) |
| **F4 redact-expired-event-buyers** (054 Task 15) | **`POST /api/cron/invoicing/redact-expired-event-buyers`** | **`0 5 * * *`** (daily 05:00 UTC = 12:00 ICT) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F4 redact-expired-event-buyers) |
| **redact-expired-member-invoices** (COMP-1 US3-B) | **`POST /api/cron/invoicing/redact-expired-member-invoices`** | **`0 5 * * *`** (daily 05:00 UTC = 12:00 ICT) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § COMP-1 redact-expired-member-invoices) |
| **088 prune-orphaned-zero-rate-certs** (US8 UX-B2) | **`POST /api/cron/invoicing/prune-orphaned-zero-rate-certs`** | **`0 21 * * *`** (daily 21:00 UTC = 04:00 ICT next day) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § 088 prune-orphaned-zero-rate-certs) |
| **F7 broadcasts dispatch** | **`POST /api/cron/broadcasts/dispatch-scheduled`** | **`*/5 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 dispatch) |
| **F7 reconcile-stuck-sending** | **`POST /api/cron/broadcasts/reconcile-stuck-sending`** | **`*/15 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 reconcile) |
| **F7 prune-expired-drafts** | **`POST /api/cron/broadcasts/prune-expired-drafts`** | **`30 4 * * *`** (daily 04:30 UTC) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 prune-drafts) |
| **F7 cleanup-audiences** (PR-2 defect #5) | **`POST /api/cron/broadcasts/cleanup-audiences`** | **`*/15 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 cleanup-audiences) — deletes terminal broadcasts' Resend audiences so the per-account audience count stays bounded |
| **F7 reclaim-orphan-audiences** (PR-2 Task 4) | **`POST /api/cron/broadcasts/reclaim-orphan-audiences`** | **`30 3 * * *`** (daily 03:30 UTC) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7 reclaim-orphan-audiences) — safety-net deleting orphaned Resend audiences whose broadcast row is gone (the per-broadcast cleanup-audiences cron can't reach those) |
| **F7 broadcasts gauges** (T172) | **`GET /api/internal/metrics/broadcasts-gauges`** | **`*/5 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | emits `broadcasts.queue_pending` + `broadcasts.stuck_sending_count` gauges per tenant |
| **F7.1a US1 split-large-broadcasts** | **`POST /api/cron/broadcasts/split-large-broadcasts`** | **`*/5 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7.1a split + dispatch-batches) — splits broadcasts whose recipient count exceeds the Resend per-audience cap into ≤10k batch manifests |
| **F7.1a US1 dispatch-batches** | **`POST /api/cron/broadcasts/dispatch-batches`** | **`*/5 * * * *`** | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F7.1a split + dispatch-batches) — dispatches pending batch manifests created by split-large-broadcasts |
| **F8 renewal dispatch (coordinator)** | **`POST /api/cron/renewals/dispatch-coordinator`** | **`0 6 * * *`** (daily 06:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 dispatch) |
| **F8 at-risk recompute (coordinator)** | **`POST /api/cron/renewals/at-risk-recompute-coordinator`** | **`0 2 * * 0`** (Sun 02:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 at-risk) |
| **F8 tier-upgrade evaluate (coordinator)** | **`POST /api/cron/renewals/tier-upgrade-evaluate-coordinator`** | **`0 3 * * 0`** (Sun 03:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 tier-upgrade) |
| **F8 reconcile-pending-reactivations (coordinator)** | **`POST /api/cron/renewals/reconcile-pending-reactivations-coordinator`** | **`0 7 * * *`** (daily 07:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 reconcile-reactivations) |
| **F8 enter-awaiting-payment (coordinator)** | **`POST /api/cron/renewals/enter-awaiting-payment-coordinator`** | **`15 6 * * *`** (daily 06:15 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 enter-awaiting-payment) |
| **F8 lapse-cycles-on-grace-expiry (coordinator)** | **`POST /api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator`** | **`30 6 * * *`** (daily 06:30 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 lapse-cycles) |
| **F8 prune consumed link tokens** | **`POST /api/cron/renewals/prune-consumed-tokens`** | **`0 4 * * 6`** (Sat 04:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 token prune) |
| **F8 reconcile pending tier-upgrades** | **`POST /api/cron/renewals/reconcile-pending-applications`** | **`0 5 * * 6`** (Sat 05:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F8 reconcile-tier-upgrades) |
| **F6 idempotency sweep** | **`POST /api/internal/retention/sweep-eventcreate-idempotency`** | **`30 3 * * *`** (daily 03:30 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F6 idempotency sweep) |
| **F6 PII pseudonymisation sweep** | **`POST /api/internal/retention/pseudonymise-eventcreate`** | **`0 4 * * *`** (daily 04:00 Asia/Bangkok) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § F6 PII sweep) |
| **F6.1 error-CSV blob TTL sweep** (T058 — folded into F6 T154 on 2026-05-19) | **`POST /api/internal/retention/sweep-error-csv-blobs`** | **`0 22 * * *`** (= 05:00 Asia/Bangkok daily) | **`Authorization: Bearer ${CRON_SECRET}`** | [eventcreate-csv-import.md § 2](./eventcreate-csv-import.md) |
| **F6 recompute match-rate gauge** (Phase 10 T126) | **`POST /api/internal/observability/recompute-match-rate`** | **`0 * * * *`** (hourly) | **`Authorization: Bearer ${CRON_SECRET}`** | [f6-match-rate-degradation-triage.md](./f6-match-rate-degradation-triage.md) — refreshes `eventcreate_match_rate_gauge` per tenant; powers SC-002 dashboard |
| **COMP-1 reconcile-erasures** (US2d) | **`POST /api/cron/members/reconcile-erasures`** | **`*/30 * * * *`** (every 30 min) | **`Authorization: Bearer ${CRON_SECRET}`** | (this file § Members — reconcile-erasures) — re-drives stuck member erasures (`erased_at` set, `member_erased` absent); kill-switch `FEATURE_MEMBER_ERASURE_RECONCILE`; **retry ON** (500-on-error → cron-job.org retries) |

> **⚡ Superseded 2026-07-17 (Pro migration):** ALL jobs above now run on
> native Vercel Cron. The **Cadence** column shows each job's *logical*
> schedule (some annotated Asia/Bangkok); the authoritative **UTC**
> `vercel.json` expression for each is in § "Migration path: Pro plan
> (DONE — 2026-07-17)". cron-job.org is a paused standby.
>
> *Pre-migration note (kept for history):* daily-cadence jobs fit Hobby's
> 1×/day limit and stayed in `vercel.json`; 5-minute jobs were mandatory
> cron-job.org externals. F6 sweep cron handlers shipped in Phase 10
> (T115/T116); the catalogue entries registered the schedule + auth
> contract ahead of the handler landing.

## Retry policy contract (READ BEFORE CONFIGURING ANY F7 JOB)

cron-job.org defaults to **retry-on-non-2xx with exponential backoff**.
For F7 jobs, **disable failure-retry** in the cron-job.org config —
both endpoints distinguish "harness should retry" from "operator
should look but harness MUST NOT retry":

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `gateway_error > 0` in body | Resend outage. Per-row reconcile already done idempotently. Next 15-min tick is the natural retry. | Check Resend status page; alert pipeline pages on the dedicated `cron.broadcasts.reconcile.gateway_outage` log channel |
| 500 + `uncaught_error > 0` | Programmer bug or transient DB blip | Harness MAY retry; investigate next morning if persistent |
| 500 + `server_error > 0` | Use-case Result.err (transition guard, RLS probe, etc.) | Harness MAY retry; investigate stack trace in logs |
| 401 | Bearer token mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org headers |
| 200 + `{ skipped: true, reason: 'feature_disabled' }` | `FEATURE_F7_BROADCASTS=false` (kill-switch) | Expected during dark-launch; do nothing. The route deliberately returns 200 + skips (NOT 503) so cron-job.org does not retry-storm. |

**Why disable failure-retry**: cron-job.org's default retry storm
(every 30s for 1 hour) on a 500 response would hammer the endpoint
during a Resend outage. The 15-min cadence already provides natural
retry; the 500 status is purely a dashboard-paint-red signal.

## F4 — redact-expired-event-buyers (NEW — 054 Task 15)

Daily retention sweep that **tombstones the buyer PII** on NON-MEMBER
event-fee invoices once their 10-year statutory retention window has
elapsed. Thai RD §87/3 + §86/10 require a §86/4 tax document be retained
for 10 years; once that elapses, GDPR Art. 5(1)(e) (storage limitation) +
Art. 17 (erasure) require the personal data on it be minimised.

### What it does

For every tenant with invoice settings, inside `runInTenant`:

1. `SET LOCAL app.allow_pii_redaction = 'true'` — authorises the
   buyer-PII change for THIS transaction only (auto-resets at tx end,
   mirroring the `app.current_tenant` GUC). See § "GUC mechanism" below.
2. Selects eligible rows (the **predicate**):
   ```sql
   invoice_subject = 'event'
     AND member_id IS NULL                         -- non-member buyer only
     AND status <> 'draft'                          -- issued/paid/void/credited
     AND issue_date < (now() - interval '10 years') -- retention elapsed
     AND member_identity_snapshot IS NOT NULL
     AND (member_identity_snapshot->>'legal_name') <> '[REDACTED]'  -- idempotent skip
   ```
3. For each, UPDATEs `member_identity_snapshot` to a tombstone preserving
   STRUCTURE: `legal_name` / `address` / `primary_contact_name` →
   `'[REDACTED]'`, `primary_contact_email` → `''`, `tax_id` → `null`.
   **Every financial / §87-numbering / pdf field is left untouched** —
   the §87/3 statutory record and any future RD audit still need them.
4. Emits one `event_buyer_pii_redacted` audit row per redaction, IN THE
   SAME TX as the UPDATE (atomic — a rollback removes both). 10-year
   retention. Payload carries `invoice_id`, `redacted_at`, and
   `redacted_fields` (field NAMES only — **never** the erased PII values).

Membership invoices are **not** touched: their buyer is a real F3 member
(`member_id IS NOT NULL`) whose PII retention is governed by the F3/F9
member-lifecycle + GDPR-export surfaces.

### Idempotency

The predicate's last clause (`legal_name <> '[REDACTED]'`) excludes
already-tombstoned rows, so re-running only ever processes
still-unredacted rows. Re-running emits no duplicate audit row.

### GUC mechanism (the immutability bypass)

`invoices_enforce_immutability` (migration 0019, amended **0205**) locks
`member_identity_snapshot` the moment a row leaves `draft`. The amended
trigger adds a GUC-gated exemption that fires ONLY when
`current_setting('app.allow_pii_redaction', true) = 'true'`. Inside that
branch **only** `member_identity_snapshot` may change — every other
snapshot / numbering / financial / identity column still RAISES
`check_violation` if touched (the exemption is buyer-PII-only). When the
GUC is unset (every normal write path), the trigger falls through to the
unchanged normal-path check that locks `member_identity_snapshot` along
with all the other columns. **Only this cron sets the GUC.**

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · F4 redact-expired-event-buyers`
   - **URL**: `https://swecham.zyncdata.app/api/cron/invoicing/redact-expired-event-buyers`
   - **Schedule**: `0 5 * * *` (daily 05:00 UTC = 12:00 ICT — low-traffic;
     the 10-year cutoff has >24h tolerance so a missed daily tick is not a
     correctness issue, the next tick catches up)
   - **Request method**: `POST`
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (reused from F4/F5/F7/F8)
   - **Timeout**: 60 seconds
   - **Retry on failure**: **OFF** (per § Retry policy contract — the sweep
     is idempotent + the next daily tick is the natural retry)
   - **Notifications**: email on ≥3 consecutive failures
3. Click **Run** to verify a 200 OK response:
   ```json
   { "ok": true, "redactedCount": 0, "tenantsSwept": 1, "tenantsErrored": 0 }
   ```
   `redactedCount: 0` is the expected steady state until a SweCham event
   invoice actually crosses its 10th anniversary.

### Expected response codes

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `redactedCount: 0` | Healthy steady state (nothing due) | None |
| 200 + `redactedCount > 0` | Buyer PII tombstoned this tick | None — expected once invoices age past 10y |
| 200 + `tenantsErrored > 0` | A per-tenant sweep threw (DB blip / GUC/trigger failure) — others unaffected | Inspect Vercel logs `cron.redact_expired_event_buyers.tenant_threw`; alert binds to `invoicing_event_buyer_pii_redacted_total{outcome=error}` |
| 401 | Bearer mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org header |
| 500 + `tenant_list_failed` | Scan-level failure (tenant-list query) | Investigate DB connectivity; harness retries next tick |

### Alert rules

- `invoicing_event_buyer_pii_redacted_total{outcome=error}` non-zero rate
  over 24h pages on-call — the §87/3 + GDPR Art. 17 erasure obligation is
  then NOT being met.
- The 10-year forensic record is the `event_buyer_pii_redacted` audit row
  (10y retention) — a future RD/DSAR audit reads it to prove WHICH columns
  were minimised WHEN.

### Handler module

`src/app/api/cron/invoicing/redact-expired-event-buyers/route.ts`

## COMP-1 — redact-expired-member-invoices (NEW — US3-B)

Daily retention sweep that **tombstones the buyer PII** on an **ERASED member's**
F4 tax documents once their Thai RD §87/3 + §86/10 10-year statutory retention
window elapses (GDPR Art.17 / PDPA §33 minimisation of the retained copy). The
sibling of `redact-expired-event-buyers` (which covers the `member_id IS NULL`
non-member event buyers); this one covers `member_id IS NOT NULL` documents of an
erased member — **membership invoices, matched-member EVENT invoices, AND credit
notes** (joined via `original_invoice_id`). For each due document it tombstones
the 5 buyer-PII fields on `member_identity_snapshot` (DB) **and** purges the issued
§86/4 / §86/10 PDF blob bytes (retryable via `pii_blob_purged_at`). Every
numbering / amount / seller / `source_refund_id` / date field is PRESERVED — only
the buyer block is minimised, so §87 no-gaps integrity holds. **No live redaction
for ~10 years** (SweCham's earliest invoices are 2026 → first fires ~2036); ships
now for correctness + so the obligation is automated when the window opens.

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · redact-expired-member-invoices`
   - **URL**: `https://swecham.zyncdata.app/api/cron/invoicing/redact-expired-member-invoices`
   - **Schedule**: `0 5 * * *` (daily 05:00 UTC = 12:00 ICT — the 10-year cutoff
     has >24h tolerance, so a missed tick is not a correctness issue)
   - **Request method**: `POST`
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (reused from F4/F5/F7/F8)
   - **Timeout**: 60 seconds
   - **Retry on failure**: **OFF** (idempotent sweep; the next daily tick is the
     natural retry)
   - **Notifications**: email on ≥3 consecutive failures
3. Click **Run** to verify a 200 OK (`redactedCount: 0` is the expected steady
   state until ~2036).

### Expected response codes

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `redactedCount: 0` | Healthy steady state (nothing due) | None |
| 200 + `redactedCount > 0` | Buyer PII tombstoned this tick (≈2036+) | None — expected |
| 200 + `tenantsErrored > 0` | A per-tenant sweep threw — others unaffected | Inspect logs `cron.redact_expired_member_invoices.tenant_threw` / `.blob_delete_failed` / `.purge_marker_failed`; alert binds to `member_document_pii_redacted_total{outcome=error}` |
| 401 | Bearer mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org header |
| 500 + `tenant_list_failed` | Tenant-list query failed | Investigate DB connectivity; harness retries next tick |

### Alert rules

- `member_document_pii_redacted_total{outcome=error}` non-zero over 24h pages
  on-call — the §87/3 + Art.17 erasure of the retained tax copy is then NOT
  being met. A stuck blob purge leaves `pii_blob_purged_at` NULL and re-tries on
  the next tick (the snapshot is already tombstoned → no PII re-exposed).
  - **Most failures self-heal**: a missing blob (`@vercel/blob` `del()` is
    idempotent on a 404) does not throw → no error. A SUSTAINED per-tenant error
    rate means a **non-self-healing** key (revoked `BLOB_READ_WRITE_TOKEN`, a key
    the token's store can't address, a persistent 5xx) — the PDF bytes (printed
    buyer PII) then persist on Blob until fixed.
  - **Manual escalation** for a sustained error: (1) grep
    `cron.redact_expired_member_invoices.blob_delete_failed` for the
    `documentId` + `errKind`; (2) verify `BLOB_READ_WRITE_TOKEN` + the store
    addresses the key; (3) once reachable the next daily tick auto-purges (the
    row is still re-selected via `pii_blob_purged_at IS NULL`), OR manually
    `del()` the key + stamp `pii_blob_purged_at` under the GUC. A
    redacted-but-unpurged backlog gauge (rows with `pii_blob_purged_at IS NULL
    AND legal_name='[REDACTED]'` older than N days) is a future hardening.
- The 10-year forensic record is the `event_buyer_pii_redacted` audit row
  (reused; 10y retention) carrying `member_id` + `document_kind` (`invoice` /
  `credit_note`) — a future RD/DSAR audit reads it to prove WHICH columns were
  minimised WHEN, per member.

### Known scope residual

A credit note issued against a **non-member EVENT** invoice (`member_id IS NULL`
parent) is redacted by **neither** cron: `redact-expired-event-buyers` only
sweeps `invoices` (never `credit_notes`), and this cron only covers
`member_id IS NOT NULL` parents. If F4 can issue a credit note against a
non-member event invoice, its buyer PII has no 10y redaction sweep — a tracked
GDPR Art.17 residual (US3-E RoPA residuals checklist; close by extending the
event-buyer cron to credit notes if the case is reachable).

### Handler module

`src/app/api/cron/invoicing/redact-expired-member-invoices/route.ts`

## 088 — prune-orphaned-zero-rate-certs (NEW — US8 UX-B2)

Daily TTL sweep that **deletes ABANDONED / SUPERSEDED §80/1(5) MFA zero-rate
certificate SCAN blobs** — files uploaded via the UX-B1 upload route
(`upload-zero-rate-cert`) onto a DRAFT invoice that was then never issued
(issue dialog cancelled, flipped to standard VAT, or superseded by a re-upload).
A cert scan is written to a server-derived key
`invoicing/<tenantId>/zero-rate-certs/<invoiceId>_<uploadedAtMs>.<ext>` and is
only PINNED onto `invoices.zero_rate_cert_blob_key` at ISSUE. A never-issued
draft leaves the blob orphaned; Vercel Blob has **no TTL**, so this cron is the
only reclaim path (the invoicing analogue of the F6 error-CSV blob TTL sweep).

### Orphan rule (the safety-critical part)

For every cert blob key, per tenant, inside `runInTenant`:

- **KEEP** iff SOME invoice (ANY status) in the key's tenant pins it
  (`zero_rate_cert_blob_key = <key>`). **A pinned cert is 10-year-retained legal
  evidence and is NEVER swept**, even on a voided / credited invoice.
- Else **DELETE** only when the blob's age (from the `<uploadedAtMs>` embedded in
  the key, vs. an injected clock — never `Date.now()`) exceeds the **48h grace
  window** (`ORPHAN_CERT_GRACE_MS`). The grace protects an in-flight mid-issue
  upload (uploaded, issue not yet committed).
- **MALFORMED** key (no parseable ms) → SKIP, never delete (age unknown).

**Fail-safe**: deletion runs ONLY after a positive confirmation the blob is
un-pinned AND past grace. If the pin probe throws (DB/RLS outage) the blob is
KEPT (retried next tick) — an unconfirmed orphan is treated as pinned. A
per-tenant `blob.list` failure skips that tenant and continues the rest; only a
tenant-LIST failure aborts the sweep (`scan_failed` → 500). Idempotent: an
already-gone blob (delete resolves as no-op, or throws not-found) counts as a
successful sweep, and a deleted key is not re-listed so it never double-counts.

**No live sweep for years** on a healthy deployment (orphans are rare —
cancelled/superseded dialogs only); ships now so the reclaim is automated.
NOT feature-gated (pure cleanup, safe regardless of the 088 flag; returns zeros
when nothing is due). No new audit event / metric — matches the F6 sweep;
observability is structured pino logs + the `scan_failed` → 500 alerting anchor.

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · 088 prune-orphaned-zero-rate-certs`
   - **URL**: `https://swecham.zyncdata.app/api/cron/invoicing/prune-orphaned-zero-rate-certs`
   - **Schedule**: `0 21 * * *` (daily 21:00 UTC = 04:00 ICT next day — low-traffic;
     the 48h grace has ample tolerance so a missed daily tick is not a
     correctness issue, the next tick catches up)
   - **Request method**: `POST`
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (reused from F4/F5/F7/F8)
   - **Timeout**: 60 seconds
   - **Retry on failure**: **OFF** (per § Retry policy contract — the sweep is
     idempotent + the next daily tick is the natural retry)
   - **Notifications**: email on ≥3 consecutive failures
3. Click **Run** to verify a 200 OK response:
   ```json
   { "ok": true, "scanned": 0, "swept": 0, "skipped": 0, "cutoff": "…" }
   ```
   `swept: 0` is the expected steady state — orphaned certs only arise from a
   cancelled/superseded issue flow.

### Expected response codes

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `swept: 0` | Healthy steady state (no orphans due) | None |
| 200 + `swept > 0` | Orphaned cert blobs reclaimed this tick | None — expected after a cancelled/superseded issue flow |
| 200 + `skipped > 0` (with `swept: 0`) | Blobs KEPT — pinned, within grace, malformed key, OR a per-blob probe/delete failure (retried next tick) | None unless `skipped` stays high across ticks → grep logs `zero_rate_cert_prune_pin_probe_failed` / `.delete_failed` / `.list_failed` for the failing tenant + `BLOB_READ_WRITE_TOKEN` health |
| 401 | Bearer mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org header |
| 500 + `scan_failed` | Tenant-list query failed OR unexpected throw (no blob deleted this tick) | Investigate DB connectivity; harness retries next tick |

### Safety note (data-loss guard)

A PINNED cert is 10y legal evidence — the sweep must NEVER delete one. The
use-case only deletes after a POSITIVE `existsInvoiceWithCertBlobKey = false`
AND age > grace; any probe error, malformed key, or list/delete failure results
in KEEP. Alert if `swept` ever exceeds the count of genuinely-cancelled issue
flows (there is no metric — this is a manual sanity check should a spike appear).

### Handler module

`src/app/api/cron/invoicing/prune-orphaned-zero-rate-certs/route.ts`

## F7 — broadcasts/dispatch-scheduled (NEW — F7 ship)

Dispatches scheduled E-Blast broadcasts whose `scheduled_for <= NOW()`
and `status='approved'`. Expected recipient cap per tick: ≤ 5,000
recipients per broadcast (FR-016a) × N broadcasts due in the window.

### Setup steps (one-time, reproducible)

1. Sign in to https://cron-job.org with the SweCham ops account
   (credentials in 1Password vault: `swecham/cron-job-org`).
2. Create new cron-job:
   - **Title**: `Chamber-OS · broadcasts.dispatch-scheduled`
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/dispatch-scheduled`
   - **Schedule**: `*/5 * * * *` (every 5 minutes, UTC)
   - **Request method**: POST
   - **Headers**:
     - `Authorization: Bearer <CRON_SECRET>` — value reused from F4/F5
       (single shared secret; rotate via the procedure in § "Secret
       rotation" below)
   - **Notifications**: enable email on failure (3 consecutive failures
     → maintainer email)
   - **Timeout**: 60 seconds (broadcast dispatch may issue several
     Resend Broadcasts API calls; the route handler is bounded by the
     dispatch loop's per-broadcast watchdog).
   - **Save attempt history**: 100 most recent (default)
3. Click **Run** to verify a 200 OK response with payload:

   ```json
   { "ok": true, "dispatched": N, "skipped": M, "stuckSendingDetected": K, "timestamp": "..." }
   ```

   - `dispatched` — broadcasts that transitioned `approved → sending`
     this tick
   - `skipped` — broadcasts due-but-blocked (e.g. tenant kill-switch,
     concurrent dispatch holding the advisory lock — both expected)
   - `stuckSendingDetected` — broadcasts sitting in `status='sending'`
     for > 24h; emit `broadcast_resend_resource_missing` audit event
     for ops follow-up. ≥1 should escalate to
     [broadcasts-stuck-sending runbook](./broadcasts-stuck-sending.md)
     (authored at T032).

4. Confirm the dispatch metric increments in Vercel OTel telemetry
   within 5 minutes (`broadcasts.cron.dispatched` counter).

### Expected response codes

| Status | Meaning | Action |
|--------|---------|--------|
| 200 | Normal dispatch tick (zero or more broadcasts handled) | None — expected |
| 202 | Tick in progress (advisory lock held by overlapping run) | None — next tick will catch up |
| 200 + `{ skipped: true, reason: 'feature_disabled' }` | `FEATURE_F7_BROADCASTS=false` (kill-switch active) | If intentional, suppress alerting; otherwise escalate to feature owner |
| 401 | `Authorization` header missing/invalid | Check cron-job.org headers UI; rotate secret if leaked |
| 5xx | Internal error (DB outage, Resend down, app crash) | Inspect Vercel logs; consult [broadcasts-dispatch-failure.md](./broadcasts-dispatch-failure.md) |

### Why POST not GET

The F7 endpoint mutates DB state (transitions broadcast rows from
`approved → sending` and emits audit events). REST convention
reserves GET for safe/idempotent reads. `cron-job.org` supports both;
choose POST per HTTP semantics.

## F7 — broadcasts/prune-expired-drafts (NEW — F7 US6 / Phase 8)

Daily housekeeping cron deleting `broadcasts WHERE status='draft' AND
updated_at < NOW() - INTERVAL '30 days'` per FR-001a (US1 AS3 draft
restoration window). Drafts are user-controlled scratch space; pruning
emits NO audit event (preserves the FR-001 "drafts do NOT consume or
reserve quota" invariant).

Members are NOT notified of impending draft expiry in MVP — a "your
draft will expire in N days" toast remains in scope for a future
polish iteration but is intentionally not part of F7 MVP.

### Setup steps (one-time, reproducible)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · broadcasts.prune-expired-drafts`
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/prune-expired-drafts`
   - **Schedule**: `30 4 * * *` (every day at 04:30 UTC = 11:30 ICT —
     low-traffic window for SweCham; chosen to avoid overlapping with
     the 5-min dispatch tick boundary). Schedule is **flexible** — the
     30-day cutoff has 24h tolerance so a missed daily tick is not a
     correctness issue (next tick catches up).
   - **Request method**: POST
   - **Headers**:
     - `Authorization: Bearer <CRON_SECRET>` — value reused from F4/F5/F7-other
   - **Notifications**: enable email on consecutive failures (3 → maintainer
     email)
   - **Timeout**: 30 seconds (single tenant DELETE statement; expected
     row count well under 1k for SweCham scale)
   - **Disable failure-retry** per § "Retry policy contract" — daily
     cadence is the natural retry; a missed day is not a blocker.
3. Click **Run** to verify a 200 OK response with payload:

   ```json
   {
     "tenantId": "swecham",
     "prunedCount": 0,
     "cutoff": "2026-04-02T04:30:00.000Z",
     "durationMs": 42
   }
   ```

   - `prunedCount: 0` is the expected steady state (drafts older than
     30 days are rare on a healthy deployment)
   - `cutoff` is the timestamp threshold passed to the DELETE; sanity
     check that it is exactly 30 days before the request time
   - `durationMs` should stay under 1s; if it climbs, investigate
     missing index or unbounded draft growth

### On-call response

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `prunedCount: 0` | Healthy steady state | None |
| 200 + `prunedCount > 100` | Unusual draft churn — investigate which member is creating drafts that age out | Query `SELECT requested_by_member_id, COUNT(*) FROM broadcasts WHERE status='draft' GROUP BY 1 ORDER BY 2 DESC LIMIT 10` for outliers |
| 500 + body contains `prune.server_error` | DB outage or RLS misconfiguration. Drafts NOT pruned this tick. | Investigate next morning; harness will retry on next daily tick — no action needed within 24h |
| 200 + `{ skipped: true, reason: 'feature_disabled' }` | `FEATURE_F7_BROADCASTS=false` (kill-switch) | Expected during dark-launch; do nothing. The route deliberately returns 200 + skips (NOT 503) so cron-job.org does not retry-storm. |
| 401 | Bearer token mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org headers |

## F7 — broadcasts/cleanup-audiences (NEW — PR-2 defect #5)

Periodic housekeeping cron that **deletes the ephemeral per-broadcast Resend
audiences** created during dispatch for broadcasts that have reached a
terminal status (`sent` / `cancelled` / `failed_to_dispatch` / `rejected` /
`partial_delivery_accepted`). Without this sweep, Resend audiences accumulate
indefinitely, wasting sub-processor storage and eventually hitting the
per-account audience plan limit.

Grace window: **1 hour** (`graceMs = 3600000`). Only broadcasts whose
`updated_at` is older than 1 hour before the tick are eligible, preventing a
race with Resend's own post-send event processing on very recently terminal
broadcasts.

Per-tick candidate limit: **50 rows** per tenant (`limit = 50`, matches
reconcile-stuck-sending's `MAX_PER_TICK`). Deletes run in chunks of 5 via
`Promise.allSettled` so the tick stays within the function timeout even
under a Resend 5xx backlog. At SweCham scale the steady-state queue depth is
near zero (one audience per terminal broadcast); the next tick picks up any
remainder.

### What it does

Per tenant, inside `cleanupOrphanedAudiences`:

1. Lists terminal broadcasts with `audience_deleted_at IS NULL` AND
   `updated_at < (now() - 1h)` via `broadcastsRepo.listTerminalBroadcastsWithLiveAudience`.
2. For each candidate (in chunks of 5, `Promise.allSettled`): calls
   `broadcastsGateway.deleteAudience(resendAudienceId)`. A 404/410 from Resend
   resolves (already gone); a 5xx throws and is caught per-item.
3. On success: stamps `audience_deleted_at = now()` via
   `broadcastsRepo.markAudienceDeletedInTx` inside a per-item tenant-bound tx
   (`broadcastsRepo.withTx`) — Constitution Principle I (RLS via `runInTenant`).
4. On throw: logs a structured warning; the row stays eligible for the next tick.
   `failed` counter increments; the batch continues (best-effort, never aborts).

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · broadcasts.cleanup-audiences`
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/cleanup-audiences`
   - **Schedule**: `*/15 * * * *` (every 15 minutes, UTC — same cadence as
     reconcile-stuck-sending; audiences accumulate slowly so 15-min is
     sufficient)
   - **Request method**: `POST`
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (reused from F4/F5/F7)
   - **Timeout**: 60 seconds (50 candidates in chunks of 5 × ~200ms Resend RTT ≈ 2s nominal; well within budget even with per-item 5xx retries)
   - **Retry on failure**: **OFF** (per § Retry policy contract — the sweep is
     idempotent + the next 15-min tick is the natural retry)
   - **Notifications**: email on ≥3 consecutive failures
3. Click **Run** to verify a 200 OK response:
   ```json
   { "processed": 0, "deleted": 0, "failed": 0 }
   ```
   `processed: 0` is the expected steady state immediately after deploy; the
   queue drains within one grace period (1h) of any terminal broadcast.

### Expected response codes

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `processed: 0` | No terminal audiences due this tick | None — expected steady state |
| 200 + `deleted > 0` | Audiences deleted this tick | None — expected |
| 200 + `failed > 0` | Some deletes failed (Resend gateway or DB blip) | Inspect Vercel logs `broadcasts.audience_cleanup.delete_failed`; next tick retries the failed rows automatically |
| 200 + `{ skipped: true, reason: 'feature_disabled' }` | `FEATURE_F7_BROADCASTS=false` (kill-switch) | Expected during dark-launch; do nothing |
| 401 | Bearer token mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org header |
| 500 + `{ error: { code: 'internal_error' } }` | List query failed (DB outage / RLS misconfiguration) | Inspect Vercel logs `cron.broadcasts.cleanup_audiences.server_error`; harness retries next tick |

### Handler module

`src/app/api/cron/broadcasts/cleanup-audiences/route.ts`

## F7 — broadcasts/reclaim-orphan-audiences (NEW — PR-2 Task 4, defect #5 companion)

Daily safety-net cron that **reclaims orphaned Resend audiences** — audiences
that exist in the Resend account but whose corresponding local broadcast row
is gone from the database. These arise when:

- A broadcast row was hard-deleted (GDPR erasure, manual purge) AFTER a Resend
  audience was already created during dispatch.
- A dispatch crashed mid-flight AFTER `gateway.createAudience` but BEFORE
  `broadcastsRepo.attachAudienceId`, leaving a Resend audience with no tracked
  DB reference.

This cron **complements** `cleanup-audiences` (which handles the case where the
broadcast row EXISTS and is terminal). Together they achieve full audience hygiene:

- **`cleanup-audiences`** → broadcast row exists, is terminal, `audience_deleted_at IS NULL` → delete audience + stamp row.
- **`reclaim-orphan-audiences`** (this job) → broadcast row is GONE → delete the dangling Resend audience.

Grace window: **24 hours**. Audiences whose `createdAt` is within the last 24h
are skipped — they may belong to an in-flight dispatch that hasn't committed
its broadcast row yet. A longer window than cleanup-audiences (1h) reduces the
risk of false-positive deletes disrupting active sends.

Per-tick candidate limit: **200** (applied after name-matching and grace
filtering). Higher than cleanup-audiences (50) because this cron runs daily
rather than every 15 min, so a larger backlog per tick is expected.

The job lists all Resend audiences for the configured API key, filters by
naming convention `broadcast-{tenantSlug}-{uuid}` (optional `-batch-N` suffix),
cross-checks extracted broadcast IDs against the DB, and deletes audiences with
no live DB row. **No DB write on success** — there is no row to stamp.

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · broadcasts.reclaim-orphan-audiences`
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/reclaim-orphan-audiences`
   - **Schedule**: `30 3 * * *` (daily 03:30 UTC = 10:30 ICT — low-traffic
     window; scheduled 30 min before `prune-expired-drafts` at 04:30 UTC for
     clean ordering. The 24h grace window has ample tolerance for a missed
     daily tick — next tick catches up automatically.)
   - **Request method**: `POST`
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (reused from F4/F5/F7)
   - **Timeout**: 60 seconds (200 candidates × listAudiences RTT + Resend
     delete RTT per chunk; comfortably within budget)
   - **Retry on failure**: **OFF** (per § Retry policy contract — the sweep is
     idempotent; the next daily tick is the natural retry)
   - **Notifications**: email on ≥3 consecutive failures
3. Click **Run** to verify a 200 OK response:
   ```json
   { "scanned": 0, "orphaned": 0, "deleted": 0, "failed": 0, "skippedNonMatching": 0 }
   ```
   At steady state `scanned` may be > 0 (there may be a `General` Resend audience
   or other tenants' audiences), but `orphaned: 0` is expected after a clean
   deployment where `cleanup-audiences` has already been running.

### Expected response codes

| HTTP code | Meaning | Operator action |
|-----------|---------|-----------------|
| 200 + `orphaned: 0` | No orphaned audiences found this tick | None — expected steady state |
| 200 + `deleted > 0` | Orphaned audiences reclaimed | None — expected after a broadcast row hard-delete |
| 200 + `failed > 0` | Some deletes failed (Resend gateway blip) | Inspect Vercel logs `broadcasts.audience_reclaim.delete_failed`; next tick retries automatically |
| 200 + `skippedNonMatching > 0` | Resend audiences not matching this tenant's naming convention (e.g. `General`, another tenant) | None — expected; these are intentionally ignored |
| 200 + `{ skipped: true, reason: 'feature_disabled' }` | `FEATURE_F7_BROADCASTS=false` (kill-switch) | Expected during dark-launch; do nothing |
| 401 | Bearer token mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org header |
| 500 + `{ error: { code: 'internal_error' } }` | `listAudiences` or DB existence check failed | Inspect Vercel logs `cron.broadcasts.reclaim_orphan_audiences.server_error`; next daily tick retries |

### Handler module

`src/app/api/cron/broadcasts/reclaim-orphan-audiences/route.ts`

## Secret rotation

`CRON_SECRET` is a single shared secret across F4 + F5 + F7
cron-driven endpoints. Rotation procedure (zero downtime):

1. Generate new secret: `openssl rand -base64 48`
2. `vercel env add CRON_SECRET <new-value> production`
3. Redeploy production (the new env value loads at boot)
4. Update **every** cron-job.org job's Bearer header in the headers UI
   — see the job catalogue table at the top of this file for the
   complete list (currently 15+ jobs across F5 stale-pending-count, F7
   dispatch-scheduled, F7 reconcile-stuck-sending, F7
   prune-expired-drafts). Verify the catalogue is up-to-date before
   rotation; missing one cron job mid-rotation causes ≤5min outage.
5. Click **Run** on each updated job to confirm 200 OK
6. After 1 hour of clean runs, optionally: `vercel env rm
   CRON_SECRET_OLD production` if you kept the old value as a fallback

Native Vercel Cron entries automatically pick up the new value via
their `Authorization` header — no UI action needed.

## Recreating after cron-job.org account loss

If the cron-job.org account is lost, every 5-minute-cadence cron
**stops firing silently** — Vercel does not synthesise a fallback.
Symptoms surface at:

- F5: `payments.stale_pending_count` gauge stays at 0 → alert won't
  fire on stuck payments
- F7: scheduled broadcasts pile up in `status='approved' AND
  scheduled_for < NOW()` and never dispatch → member-facing complaint

Recovery:

1. Create a new cron-job.org account (free tier sufficient).
2. Re-run the per-job setup steps in this runbook + linked detail
   runbooks for each job in the catalogue table above.
3. Within 6 minutes confirm metric/audit increment.
4. Audit the gap window: `SELECT * FROM broadcasts WHERE status =
   'approved' AND scheduled_for < NOW();` — manually trigger
   dispatch via the endpoint if backlog is non-empty.

## Migration path: Pro plan (DONE — 2026-07-17)

SweCham upgraded to Vercel Pro and **all 32 cron jobs now run on native
Vercel Cron** via `vercel.json`. This section is the authoritative
mapping. cron-job.org is a **paused standby** (kept, not deleted).

### Why the handler code changed (GET alias)

Vercel Cron triggers each path with a **GET**. Cron handlers that were
`POST`-only now also `export const GET = POST` (25 handlers). This is
safe: no cron handler reads a request body (verified), the shared
`CRON_SECRET` Bearer gate applies identically to both verbs, and Vercel
auto-injects `Authorization: Bearer ${CRON_SECRET}` when the env var is
set. The `POST` export is retained so cron-job.org can still fire during
the standby window. Pattern mirrors the pre-existing `export const POST =
GET` in `lockout-cleanup` / `outbox-dispatch`.

### Why the schedules look shifted (UTC conversion)

Vercel Cron is **UTC-only** — there is no per-job timezone. Jobs that ran
on cron-job.org in **Asia/Bangkok** (UTC+7) are shifted **−7h** in
`vercel.json`. The F8 daily chain keeps its load-bearing ordering
(dispatch → enter-awaiting → lapse → reconcile) because every job shifts
uniformly. Weekly F8 jobs also shift day-of-week (Sun ICT → Sat UTC;
Sat ICT → Fri UTC).

### Authoritative `vercel.json` ↔ logical-schedule mapping (32 jobs)

Pro plan limit is 40 cron jobs/project — 32 used, 8 headroom.

| `vercel.json` path | UTC schedule | Logical time / cadence | Verb |
|---|---|---|---|
| `/api/cron/outbox-dispatch` | `* * * * *` | every 60s (transactional email drainer) | GET+POST |
| `/api/internal/metrics/stale-pending-count` | `*/5 * * * *` | every 5 min | GET |
| `/api/internal/metrics/broadcasts-gauges` | `*/5 * * * *` | every 5 min | GET |
| `/api/cron/broadcasts/dispatch-scheduled` | `*/5 * * * *` | every 5 min | GET+POST |
| `/api/cron/broadcasts/split-large-broadcasts` | `*/5 * * * *` | every 5 min | GET+POST |
| `/api/cron/broadcasts/dispatch-batches` | `*/5 * * * *` | every 5 min | GET+POST |
| `/api/cron/broadcasts/reconcile-stuck-sending` | `*/15 * * * *` | every 15 min | GET+POST |
| `/api/cron/broadcasts/cleanup-audiences` | `*/15 * * * *` | every 15 min | GET+POST |
| `/api/cron/broadcasts/reclaim-orphan-audiences` | `30 3 * * *` | 03:30 UTC (10:30 ICT) | GET+POST |
| `/api/cron/broadcasts/prune-expired-drafts` | `30 4 * * *` | 04:30 UTC (11:30 ICT) | GET+POST |
| `/api/cron/insights/snapshot-refresh-coordinator` | `*/5 * * * *` | every 5 min | GET+POST |
| `/api/cron/insights/process-export-jobs` | `*/5 * * * *` | every 5 min | GET+POST |
| `/api/cron/members/reconcile-erasures` | `*/30 * * * *` | every 30 min | GET+POST |
| `/api/internal/observability/recompute-match-rate` | `0 * * * *` | hourly | GET+POST |
| `/api/cron/renewals/dispatch-coordinator` | `0 23 * * *` | **06:00 ICT** | GET+POST |
| `/api/cron/renewals/enter-awaiting-payment-coordinator` | `15 23 * * *` | **06:15 ICT** | GET+POST |
| `/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator` | `30 23 * * *` | **06:30 ICT** | GET+POST |
| `/api/cron/renewals/reconcile-pending-reactivations-coordinator` | `0 0 * * *` | **07:00 ICT** | GET+POST |
| `/api/cron/renewals/at-risk-recompute-coordinator` | `0 19 * * 6` | **Sun 02:00 ICT** (Sat 19:00 UTC) | GET+POST |
| `/api/cron/renewals/tier-upgrade-evaluate-coordinator` | `0 20 * * 6` | **Sun 03:00 ICT** (Sat 20:00 UTC) | GET+POST |
| `/api/cron/renewals/prune-consumed-tokens` | `0 21 * * 5` | **Sat 04:00 ICT** (Fri 21:00 UTC) | GET+POST |
| `/api/cron/renewals/reconcile-pending-applications` | `0 22 * * 5` | **Sat 05:00 ICT** (Fri 22:00 UTC) | GET+POST |
| `/api/cron/invoicing/redact-expired-event-buyers` | `0 5 * * *` | 05:00 UTC (12:00 ICT) | GET+POST |
| `/api/cron/invoicing/redact-expired-member-invoices` | `0 5 * * *` | 05:00 UTC (12:00 ICT) | GET+POST |
| `/api/cron/invoicing/prune-orphaned-zero-rate-certs` | `0 21 * * *` | 21:00 UTC (04:00 ICT next day) | GET+POST |
| `/api/internal/retention/sweep-eventcreate-idempotency` | `30 20 * * *` | **03:30 ICT** (20:30 UTC) | GET+POST |
| `/api/internal/retention/pseudonymise-eventcreate` | `0 21 * * *` | **04:00 ICT** (21:00 UTC) | GET+POST |
| `/api/internal/retention/sweep-error-csv-blobs` | `0 22 * * *` | 22:00 UTC (05:00 ICT) | GET+POST |
| `/api/cron/outbox-purge` | `15 20 * * *` | 20:15 UTC (native since Hobby) | GET |
| `/api/cron/sweep-stale-pending-refunds` | `0 3 * * *` | 03:00 UTC (native since Hobby) | GET |
| `/api/internal/cron/receipt-pdf-reconcile` | `*/5 * * * *` | every 5 min (≤5-min receipt-PDF recovery SLA) | GET |
| `/api/cron/lockout-cleanup` | `45 3 * * *` | 03:45 UTC (native since Hobby) | GET |

> **`reconcile-erasures` retry note:** on cron-job.org this job used
> retry-ON (500 → retry). Vercel Cron has **no auto-retry** — the
> `*/30 * * * *` cadence *is* the retry, and the idempotent
> `NOT EXISTS member_erased` anti-join makes a re-run safe. This also
> removes the concurrent-double-`member_erased` window the cron-job.org
> retry created (the 300s-timeout mitigation is no longer needed once the
> job is Vercel-native).

> **`receipt-pdf-reconcile` cadence correction:** on Hobby this job's
> **primary** trigger was cron-job.org at **`*/5 * * * *`** (its ≤5-min
> receipt-PDF recovery SLA — a failed render must re-enqueue within 5 min
> per T166-11); the Hobby `vercel.json` entry was only a **daily
> fallback** (`30 3 * * *`). On Pro the native entry takes over the
> primary 5-minute cadence directly, so pausing cron-job.org does NOT
> degrade the recovery SLA. The other 3 pre-existing native jobs
> (`outbox-purge` 03:15 ICT, `sweep-stale-pending-refunds` daily,
> `lockout-cleanup` daily) were already at their intended cadence and are
> unchanged.

### Operator steps

**One-time, on the deploy that ships this change:**

1. **Confirm `CRON_SECRET` is set** in Vercel Production env (it already
   is — the 4 pre-existing native crons depend on it). Vercel only
   injects the `Authorization: Bearer ${CRON_SECRET}` header when this
   env var exists; without it every cron 401s.
   ```bash
   vercel env ls | grep CRON_SECRET     # expect a Production entry
   ```
2. **Deploy to Production.** Cron jobs in `vercel.json` are registered
   **only on a production deploy** (not preview). Merge to `main` /
   `vercel --prod`.
3. **Verify registration:** Vercel Dashboard → Project → **Settings →
   Cron Jobs** should list all 32 (or `vercel crons ls`). Each shows its
   next run time in UTC.
4. **Smoke-test a few** without waiting for the schedule:
   ```bash
   vercel crons run /api/cron/outbox-dispatch
   vercel crons run /api/cron/renewals/dispatch-coordinator
   ```
   Or curl directly (GET, with the secret):
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" \
     https://swecham.zyncdata.app/api/cron/outbox-dispatch
   ```
   Expect `200`. Feature-flag-OFF jobs return `200 { skipped: true }`
   (dark-launch-safe) — that is correct, not a failure.
5. **Watch one full cycle** of the 5-min jobs in Vercel logs (Dashboard →
   Deployments → Functions) — confirm `dispatch-scheduled`,
   `outbox-dispatch`, `stale-pending-count`, `broadcasts-gauges` fire and
   return 200.

**After Vercel crons are confirmed firing (overlap window is safe —**
**every handler is advisory-locked / idempotent, so a double-fire from**
**cron-job.org + Vercel in the same window no-ops the second run):**

6. **Pause (do NOT delete)** every cron-job.org job in the SweCham ops
   account. Keep them as standby in case Pro limits ever change again.
   The job catalogue table at the top of this file is the complete list
   to pause.
7. Leave this runbook's status banner as the source of truth.

### Rollback

Revert the `vercel.json` change (removes the native crons on the next
prod deploy) and un-pause the cron-job.org jobs. The `export const GET =
POST` handler aliases are additive and harmless to leave in place. No DB
or data migration is involved.

## F7.1a — split + dispatch-batches (NEW — F7.1a US1, ship-day T141)

F7.1a US1 lets a broadcast exceed the Resend per-audience cap (up to
50k recipients) by fanning out into ≤10k-recipient batches. Two
cron-job.org coordinators drive it, BOTH every 5 minutes, BOTH
`POST` with `Authorization: Bearer ${CRON_SECRET}`:

1. **`split-large-broadcasts`** — finds `approved` broadcasts whose
   resolved recipient count exceeds the per-audience cap and creates
   the batch manifests (idempotent; a broadcast already split is a
   no-op).
2. **`dispatch-batches`** — finds pending batch manifests and
   dispatches each via the Resend Broadcasts API (advisory-locked per
   (tenant, broadcast); at-most-once via the row-state guard).

Ordering: the two run independently — split creates manifests, dispatch
consumes them on a later tick. No cross-job ordering guarantee is
needed (eventual consistency; a freshly-split broadcast is picked up by
the next dispatch tick within 5 min).

### Setup steps (one-time, ship-day T141)

For EACH of the two jobs, in the cron-job.org dashboard:

1. **Create cronjob** →
   - **Title**: `Chamber-OS · broadcasts.split-large-broadcasts`
     (resp. `…broadcasts.dispatch-batches`)
   - **URL**: `https://swecham.zyncdata.app/api/cron/broadcasts/split-large-broadcasts`
     (resp. `…/dispatch-batches`)
   - **Schedule**: every 5 minutes (`*/5 * * * *`)
   - **Request method**: `POST`
   - **Request headers**: `Authorization: Bearer <CRON_SECRET value>`
   - **Timeout**: 60 seconds
   - **Retry**: OFF (per § Retry policy — the next 5-min tick is the
     natural retry; the routes are idempotent + advisory-locked).
2. Save + run once manually → expect `200`.

### Expected response codes (both jobs)

| Status | Meaning | Action |
|--------|---------|--------|
| 200 | Normal tick (zero or more broadcasts handled) | None |
| 202 | Overlapping run holds the advisory lock | None — next tick catches up |
| 401 | Bearer mismatch | Rotate `CRON_SECRET`; reconfigure headers |
| 200 + `{ skipped: true }` | `FEATURE_F71A_BROADCAST_ADVANCED=false` or `FEATURE_F71A_US1_PAGINATION=false` | Expected while US1 is dark; do nothing |

> **Dark-launch note**: until US1 is flipped on (ship-day T146) both
> routes return `200 + { skipped: true }` (kill-switch — NOT 503, so
> cron-job.org does not retry-storm). Configure the jobs at T141 but
> expect the skipped-200 until the flag flip — that is correct, not an
> incident.

## F8 — renewals/dispatch-coordinator (NEW — F8 Phase 4)

Coordinator endpoint that fans out per-tenant renewal-reminder dispatch (per
research.md R14). For each active tenant the coordinator parallel-fetches
`/api/cron/renewals/dispatch/[tenantId]`; each per-tenant invocation runs in
its own Vercel function 300s budget. Bearer-auth via shared `CRON_SECRET`
(rotated atomically across F4/F5/F7/F8 per R17). Emits
`cron_dispatch_orchestrated` audit; per-tenant fault isolation; SaaS-scale
ready (50+ tenants).

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · F8 renewal-dispatch coordinator`
   - **URL**: `https://swecham.zyncdata.app/api/cron/renewals/dispatch-coordinator`
   - **Schedule**: `0 6 * * *` (daily 06:00 Asia/Bangkok = 23:00 UTC prior day)
   - **Method**: POST
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (copy from Vercel env)
   - **Timeout**: 60 seconds
3. Click **Run** to verify 200 OK with payload:
   ```json
   { "skipped": false, "tenants_enqueued": N, "tenants_succeeded": N, "tenants_failed": 0, "duration_ms": <small> }
   ```

## F8 — renewals/at-risk-recompute-coordinator (NEW — F8 Phase 6)

Weekly batch-recompute of member at-risk scores (8-factor formula per FR-029
+ FR-029a F6-readiness fallback + FR-030 proportional bands). Per-tenant
fan-out same as dispatch coordinator. Per-member `computeAtRiskScore` call
inside per-tenant route emits `at_risk_score_recomputed` (one per recomputed
member) + `at_risk_score_threshold_crossed` (when member's band crosses UP)
+ `at_risk_skipped_below_min_tenure` (members < min-tenure threshold per
FR-035). Cron-pass-level `at_risk_compute_partial_failure` audit on aggregate
non-zero member-failure count. Coordinator emits `cron_dispatch_orchestrated`
(re-using the existing typed shape) summarising tenants enqueued / succeeded
/ failed / skipped-by-kill-switch.

Per-tenant advisory lock: `pg_advisory_xact_lock(hashtextextended(
'renewals:at-risk:'||tenant_id, 0))`. Distinct namespace from
`renewals:dispatch:` so daily dispatch and weekly at-risk recompute can run
concurrently without contention.

Granular kill-switch: `FEATURE_F8_AT_RISK_DISABLED=true` short-circuits ONLY
this surface (returns 200 + `{skipped: true, reason: 'at_risk_disabled'}`)
without disabling the rest of F8 (dispatch + tier-upgrade + escalation
tasks unaffected). Designed for incident response when formula calibration
ships bad signals; restored via env-var revert + redeploy in <5 minutes.
The whole-F8 kill-switch `FEATURE_F8_RENEWALS=false` also short-circuits
both coordinator + per-tenant routes.

### Setup steps

Same pattern as dispatch coordinator with these differences:
- **Title**: `Chamber-OS · F8 at-risk recompute coordinator`
- **URL**: `https://swecham.zyncdata.app/api/cron/renewals/at-risk-recompute-coordinator`
- **Method**: `POST`
- **Schedule**: `0 2 * * 0` (Sun 02:00 Asia/Bangkok)
- **Timeout**: 60 seconds (per-tenant SLO ≤60s @ 5k members per FR-036 +
  SC-005)
- **Retry**: **OFF** per § Retry policy contract — re-runnable + idempotent
  (score writes overwrite previous values; `risk_score_last_computed_at`
  surfaces last-success timestamp). A failed cron pass simply means scores
  stay at their previous values until the next Sunday — no data loss.
- **Auth**: `Authorization: Bearer ${CRON_SECRET}` (rotated atomically with
  F4/F5/F7/F8 per R17)

### Expected response codes
- `200 {skipped: false, ...summary}` — happy path with per-tenant counts
- `200 {skipped: true, reason: 'feature_flag_disabled'}` — F8 kill-switch on
- `200 {skipped: true, reason: 'at_risk_disabled'}` — granular kill-switch on
- `401 {error: {code: 'unauthorized'}}` — Bearer rejected (audit emitted)
- `429 {error: {code: 'rate_limited'}}` — sustained Bearer-rejection probe
- `500` — unexpected coordinator-level error (per-tenant errors degrade to
  `tenants_failed > 0` in the 200 response, not 500)

## F8 — renewals/tier-upgrade-evaluate-coordinator (NEW — F8 Phase 7)

Weekly evaluation of tier-upgrade eligibility per F2 plan thresholds
(`min_turnover_minor_units`). Creates `tier_upgrade_suggestions` rows
for objective candidates + emits `tier_upgrade_suggested` audit.
Branches on `tenant_renewal_settings.auto_upgrade_enabled` (skip when
false → `tier_upgrade_tenant_disabled`) and on plan-catalogue presence
of any `min_turnover` (skip when none configured →
`tier_upgrade_skipped_no_thresholds_configured`). Idempotent —
re-running produces zero duplicates (member_open partial UNIQUE).

### Setup steps

- **Title**: `Chamber-OS · F8 tier-upgrade evaluate coordinator`
- **URL**: `https://swecham.zyncdata.app/api/cron/renewals/tier-upgrade-evaluate-coordinator`
- **Method**: `POST`
- **Schedule**: `0 3 * * 0` (Sun 03:00 Asia/Bangkok — 1h after at-risk)
- **Timeout**: 30 seconds (per-tenant SLO ≤30s @ 5k members per FR-057)
- **Retries**: OFF (the route emits `cron_dispatch_orchestrated` audit on every pass — retry-on-failure would double-fire the orchestration audit)
- **Auth**: HTTP header `Authorization: Bearer ${CRON_SECRET}` (same secret as F7 + F8 dispatch + F8 at-risk-recompute)
- **Notification**: enable email-on-failure (cron-job.org built-in)

### Expected response codes

| Code | Body shape | Meaning |
|------|------------|---------|
| 200 | `{ skipped: false, tenants_enqueued, tenants_succeeded, tenants_failed, ... }` | Normal pass |
| 200 | `{ skipped: true, reason: 'feature_flag_disabled' }` | `FEATURE_F8_RENEWALS=false` (dark launch) |
| 401 | `{ error: { code: 'unauthorized' } }` | Bearer mismatch (rotate secret + reconfigure) |
| 500 | (per-tenant fan-out caught at coordinator) | Per-tenant failures aggregated; coordinator returns 500 only on infra failure |

## F8 — renewals/reconcile-pending-applications (NEW — F8 Phase 7)

Weekly housekeeping cron that detects orphaned tier-upgrade
suggestions in `accepted_pending_apply` whose `target_apply_at_cycle_id`
is `cancelled` or `lapsed` (the F4 invoice-paid hook would never
fire). Transitions each orphan to `dismissed` with
`reason='orphan_target_cycle_terminal'` + emits
`tier_upgrade_pending_orphan_detected`. Idempotent (dismissed orphans
excluded from next pass).

### Setup steps

- **Title**: `Chamber-OS · F8 reconcile pending tier-upgrade applications`
- **URL**: `https://swecham.zyncdata.app/api/cron/renewals/reconcile-pending-applications`
- **Method**: `POST`
- **Schedule**: `0 5 * * 6` (Sat 05:00 Asia/Bangkok — distinct day-of-week from evaluate-coordinator so weekly streams stay disjoint)
- **Timeout**: 30 seconds (small dataset — only `accepted_pending_apply` rows)
- **Retries**: OFF (no orchestration audit; idempotent at suggestion-row level)
- **Auth**: HTTP header `Authorization: Bearer ${CRON_SECRET}` (same secret)
- **Notification**: enable email-on-failure

### Expected response codes

| Code | Body shape | Meaning |
|------|------------|---------|
| 200 | `{ skipped: false, tenant_id, orphans_detected, orphans_dismissed, duration_ms }` | Normal pass |
| 200 | `{ skipped: true, reason: 'feature_flag_disabled' }` | `FEATURE_F8_RENEWALS=false` |
| 401 | `{ error: { code: 'unauthorized' } }` | Bearer mismatch |
| 500 | `{ error: { code: 'server_error' } }` | Repo-level failure; review pino logs |

## F8 — renewals/reconcile-pending-reactivations-coordinator (NEW — F8 Phase 5)

Daily T-7/T-3/T-1 reminder ladder + 30d auto-timeout for cycles in
`pending_admin_reactivation` state per FR-005c. Auto-cancels timed-out cycles
+ triggers F5 refund + F4 credit-note creation atomically. Emits
`lapsed_member_admin_reactivation_reminder_t-7/-3/-1` and
`lapsed_member_admin_reactivation_timed_out` audits.

### Setup steps

- **Title**: `Chamber-OS · F8 reconcile-pending-reactivations coordinator`
- **URL**: `.../api/cron/renewals/reconcile-pending-reactivations-coordinator`
- **Schedule**: `0 7 * * *` (daily 07:00 Asia/Bangkok — 1h after dispatch)
- **Timeout**: 30 seconds (small dataset; partial-index scan)

## F8 — renewals/enter-awaiting-payment-coordinator (NEW — F8-completion slice 2)

Daily transitions cycles from `upcoming`/`reminded` → `awaiting_payment`
once `now() >= expires_at` (T-0). This is the writer that makes a cycle
**payable**: until this cron runs, no cycle is `awaiting_payment` for
most members, so the self-service confirm + paid-completion paths are
unreachable. Emits a typed `renewal_entered_awaiting_payment` audit per
cycle with `source: 'cron'` (the lazy confirm-renewal self-transition
emits the same event with `source: 'confirm'`).

**Sequencing rationale**: scheduled at 06:15 — 15 minutes AFTER the F8
dispatch coordinator (06:00) and 15 minutes BEFORE the lapse coordinator
(06:30). The ordering is load-bearing: a cycle must become
`awaiting_payment` HERE at T-0 before the lapse cron can (later, after
the grace window) consider it. The two crons therefore COMPOSE: enter →
`awaiting_payment` at 06:15, later (once `now > expires_at + grace`)
lapse → `lapsed`. The eligibility boundary is `expires_at <= now` with
NO grace offset, disjoint from the lapse cron's `< now - grace`, so a
cycle is never eligible for both in one pass.

### Setup steps

- **Title**: `Chamber-OS · F8 enter-awaiting-payment coordinator`
- **URL**: `https://swecham.zyncdata.app/api/cron/renewals/enter-awaiting-payment-coordinator`
- **Schedule**: `15 6 * * *` (daily 06:15 Asia/Bangkok)
- **Timeout**: 30 seconds (small dataset; partial-index scan via
  `listCyclesEligibleForAwaitingPayment`)
- **Headers**: `Authorization: Bearer ${CRON_SECRET}` (constant-time
  check; `verifyCronBearer`)
- **Retry policy**: OFF (per F8/F4/F5/F7 convention — cron-job.org retry
  would re-issue the list query; the use-case's per-cycle fault isolation
  + CAS-guarded idempotent flip + tomorrow's-pass already handle
  transient DB blips. A re-flip of an already-`awaiting_payment` cycle is
  skipped as `race_skipped`, never double-flipped.)

### Pre-flight gates (operator checklist before flag-flip)

1. `FEATURE_F8_RENEWALS=true` in Vercel production env
2. Confirm migration `0215_f8_renewal_entered_awaiting_payment.sql`
   applied to live Neon (`renewal_entered_awaiting_payment` value present
   in `audit_event_type` pgEnum) — verify via:
   `SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_event_type'::regtype AND enumlabel = 'renewal_entered_awaiting_payment';`
3. Confirm this coordinator is scheduled BEFORE the lapse coordinator
   (06:15 < 06:30) so the enter → awaiting → lapsed composition holds.
4. **First-run / post-outage backlog triage.** The compose guarantee
   (a cycle gets a payable window before it can lapse) holds only when
   the enter-cron runs at least once per `grace_period_days`. Before the
   FIRST enter-cron run, or after any enter-cron outage longer than
   `grace_period_days`, a cycle may be `upcoming|reminded` AND already
   `expires_at < now - grace` — it would flip to `awaiting_payment` at
   06:15 and lapse at 06:30 the same day (member gets no self-service
   window). Triage manually first:
   `SELECT cycle_id FROM renewal_cycles WHERE status IN ('upcoming','reminded') AND expires_at < now() - (SELECT grace_period_days FROM tenant_renewal_settings WHERE tenant_id = :tenant) * INTERVAL '1 day';`
   (At the 2026-06-13 SweCham launch this backlog was empirically 0.)
5. **`grace_period_days = 0` caution.** With grace=0 the lapse window
   collapses to `expires_at < now`, so EVERY cycle flipped at 06:15
   lapses the same day at 06:30 — there is no self-service payable
   window. This is pre-existing to the lapse cron (any `awaiting_payment`
   cycle already had this exposure). **Amended 2026-07-13
   (059-membership-suspension)**: this line previously read "SweCham uses
   the default 14" — SUPERSEDED. TSCC's confirmed policy is **90 days**
   of credit before termination (see § "Step 1" below for the operator
   SQL and its mandatory ordering constraint — it MUST NOT run before the
   059 Slice 1 benefit-suspension enforcement is live). Do NOT assume the
   currently-live value is 14, 30, or 90 without querying it first — the
   code-shipped migration default is 14, an earlier ops note below
   claimed a hand-run 30 that may never have executed, and 90 is the
   target once Slice 1 ships. Regardless of the live value, do NOT set
   grace=0 unless "instant-lapse, no self-service window" is intended.

### Alert rules

- `renewals_enter_awaiting_cycles_errors_total{tenant}` — non-zero rate
  sustained for 15 min pages on-call (per-cycle failures masked behind
  200 OK; symptomatic of DB connectivity or audit-emit issue)
- Per-tenant route 5xx rate (Vercel logs) >0% over 15 min — operational
  failure (use-case threw at outer level, fault-isolation contract broken)
- `tenants_with_errors > 0` in coordinator response — surfaces the
  "200-OK-but-everything-failed" pattern

## F8 — renewals/lapse-cycles-on-grace-expiry-coordinator (NEW — F8 Phase 5 Wave K24)

Daily transitions cycles from `awaiting_payment` → `lapsed` once
`now() > expires_at + tenant.grace_period_days` per FR-004. Decision
branch picks the **specific** `closed_reason` discriminator per AS3:

- `'grace_expired'` — zero F5 `payments` rows with `status='failed'`
  for the cycle's linked invoice (member silently let it expire)
- `'payment_failed'` — at least one F5 row with `status='failed'`
  before grace window expired (payment friction, not apathy)

Emits typed `renewal_lapsed` audit per cycle with the closed_reason
discriminator + forensic `failed_payment_attempts` count.

**Sequencing rationale**: scheduled at 06:30 — 30 minutes BEFORE the
reconcile-pending-reactivations coordinator (07:00) and 30 minutes
AFTER the F8 dispatch coordinator (06:00). A cycle that JUST crossed
grace doesn't get a final reminder dispatch race because dispatcher
finished at 06:00, lapse runs at 06:30, then reconcile-pending runs
at 07:00 against the post-lapse state. T115a (closeout of the
Phase-5-DEFERRED branch).

### Setup steps

- **Title**: `Chamber-OS · F8 lapse-cycles-on-grace-expiry coordinator`
- **URL**: `https://swecham.zyncdata.app/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator`
- **Schedule**: `30 6 * * *` (daily 06:30 Asia/Bangkok)
- **Timeout**: 30 seconds (small dataset; partial-index scan via
  `listCyclesEligibleForLapse`)
- **Headers**: `Authorization: Bearer ${CRON_SECRET}` (constant-time
  check; `verifyCronBearer`)
- **Retry policy**: OFF (per F8/F4/F5/F7 convention — cron-job.org
  retry would double-emit; the use-case's per-cycle fault isolation
  + tomorrow's-pass already handles transient F5 / DB blips)

### Pre-flight gates (operator checklist before flag-flip)

1. `FEATURE_F8_RENEWALS=true` in Vercel production env
2. Verify `tenant_renewal_settings` row exists for SweCham tenant
   (defaults to `gracePeriodDays=14`; seeded by migration 0089)
3. Confirm `pnpm check:multi-tenant` shows F5 `payments` table in the
   24/24 SCOPED tables list (RLS+FORCE active — required for the F5
   bridge tenant-scoped count)
4. Confirm migration `0110_f8_wave_k24_renewal_lapsed_enum.sql`
   applied to live Neon (`renewal_lapsed` value present in
   `audit_event_type` pgEnum) — verify via:
   `SELECT 1 FROM pg_enum WHERE enumtypid = 'audit_event_type'::regtype AND enumlabel = 'renewal_lapsed';`

### Alert rules

- `renewals_lapse_cycles_errors_total{tenant}` — non-zero rate
  sustained for 15 min pages on-call (per-cycle failures masked
  behind 200 OK; symptomatic of F5 bridge or DB connectivity issue)
- Per-tenant route 5xx rate (Vercel logs) >0% over 15 min — operational
  failure (use-case threw at outer level, fault-isolation contract broken)
- `tenants_with_errors > 0` in coordinator response (Wave K25
  K24-Errors-S1 fix) — surfaces "200-OK-but-everything-failed" pattern

## F8 — renewals/prune-consumed-tokens (NEW — F8 Phase 9)

Weekly housekeeping: deletes rows from `consumed_link_tokens` table where
`consumed_at < now() - interval '60 days'`. Prevents unbounded growth
(per /speckit.critique round 1 / E7). Trivial maintenance — single SQL
DELETE statement.

### Setup steps

- **Title**: `Chamber-OS · F8 prune consumed link tokens`
- **URL**: `.../api/cron/renewals/prune-consumed-tokens`
- **Schedule**: `0 4 * * 6` (Sat 04:00 Asia/Bangkok)
- **Timeout**: 30 seconds

## F8 — renewals/reconcile-pending-applications (NEW — F8 Phase 7)

Weekly reconciliation: detects orphaned `tier_upgrade_suggestions` where
`status='accepted_pending_apply'` and `target_apply_at_cycle_id` references
a cycle that's already terminal (completed/lapsed/cancelled) without the
suggestion having transitioned to `applied` or `superseded`. Emits
`tier_upgrade_pending_orphan_detected` audit for admin investigation
(does NOT auto-resolve — orphan implies missed F4 invoice-creation hook,
genuine bug surfaces in audit).

### Setup steps

- **Title**: `Chamber-OS · F8 reconcile pending tier-upgrades`
- **URL**: `.../api/cron/renewals/reconcile-pending-applications`
- **Schedule**: `0 5 * * 6` (Sat 05:00 Asia/Bangkok — 1h after token prune)
- **Timeout**: 5 seconds (small table + partial-index-driven scan)

## F8 — Rolling-anchor ship-day ops (renewal-rolling-anchor, 2026-07-09)

One-time operator steps that accompany the rolling-anchor deploy (spec
`docs/superpowers/specs/2026-07-08-renewal-rolling-anchor-design.md`,
migration 0238). NOT a cron — listed here because this file is the F8
operator reference and both steps must land in the same ship window as
the code deploy.

### Step 1 — grace period → 90 days (R7; superseded 2026-07-13 by TSCC written policy)

> **Amended 2026-07-13 (059-membership-suspension)**: TSCC subsequently
> confirmed a **fixed, written policy** — see
> `docs/superpowers/specs/2026-07-13-membership-benefit-suspension-design.md`
> § Purpose: members get 90 days of credit on the renewal invoice, during
> which benefits are suspended (not "retained" — see
> `specs/011-renewal-reminders/spec.md` FR-003 amendment), and membership
> terminates if the 90 days elapse unpaid. This SUPERSEDES the "board
> discretion per case" / 30-days-chosen-default note immediately below,
> which is kept for history, not current guidance. The target value
> changes from 30 to **90**.

~~TSCC's public site states membership lapses when the fee is overdue more
than 30 days. Map it onto the existing config knob:~~

```sql
UPDATE tenant_renewal_settings SET grace_period_days = 90 WHERE tenant_id = 'swecham';
```

> ~~**Status (RESOLVED 2026-07-09)**: TSCC confirmed there is no fixed
> lapse policy — it is board discretion per case. 30 days is therefore
> the CHOSEN DEFAULT (matches their public-site wording and common
> chamber practice), not a compliance requirement. The board can change
> it any time by updating this single config value (`grace_period_days`,
> valid range 0–90) — no deploy needed. F8 counts the grace window from
> period end; 30 is strictly more forgiving than the seeded default 14,
> so applying it at ship is low-risk.~~ **SUPERSEDED 2026-07-13** — see
> the amendment note above; the policy is now fixed at 90, not board
> discretion.

> ⚠️ **CRITICAL — ordering constraint.** This SQL **MUST NOT run before
> the 059-membership-suspension Slice 1 benefit-suspension enforcement is
> live** in production (the enforcement that actually blocks a suspended
> member's benefits: `deriveMembershipAccess` wired at the portal
> chokepoints — `requireMemberContext` + the portal layout — plus the F7
> `submitBroadcast` / F3 `inviteColleague` use-case gates, and
> `check:portal-guard` green). Before Slice 1 ships, "grace" only means
> `renewal_cycle.status = awaiting_payment` with **no benefit blocking
> whatsoever** — running this UPDATE in that state gives every unpaid
> member a **90-day free-benefits ride** with zero enforcement. Confirm
> Slice 1 is live (flag-flipped, chokepoints wired, gate green) BEFORE
> applying this SQL. This is a ship-day OPERATOR step, documented here —
> it is NOT executed as part of this documentation task.
>
> Valid range remains **0–90** (`GRACE_PERIOD_DAYS_MAX = 90` in
> `src/modules/renewals/domain/tenant-renewal-settings.ts`) — 90 is now
> also the ceiling, so this SQL sets the maximum, not headroom below it.

Verify the CURRENT value first — do not assume it is 14, 30, or 90:

```sql
SELECT tenant_id, grace_period_days FROM tenant_renewal_settings WHERE tenant_id = 'swecham';
```

(The code-shipped migration default is 14; the "30" note directly above
was a hand-run SQL that may never have executed — this file has carried
both claims without reconciliation. Verify empirically before applying
the 90-day UPDATE above, then verify again with the same SELECT
afterward.)

### Step 2 — backfill cycle anchors from TSCC payment dates (R4)

Members onboarded before this deploy have cycles provisionally anchored at
`registration_date`. Re-anchor them to TSCC's recorded payment dates with
`scripts/backfill-cycle-anchors.ts` (full docs in the script header):

```bash
# 1. Author the CSV from TSCC's records (PII — keep OUTSIDE the repo):
#    company_name,payment_date[,period_from,period_to]
#    - explicit period_from/period_to WIN (the ~6 legacy full-year members
#      keep their fixed calendar-year window, e.g. 2026-01-01,2026-12-31)
#    - otherwise: period = first day of payment month → +12 months

# 2. DRY-RUN first — prints matched/unmatched/skips, writes NOTHING:
TENANT_SLUG=swecham node --env-file=.env.production --import tsx \
  scripts/backfill-cycle-anchors.ts path/to/tscc-payment-dates.csv

# 3. Review the plan output (unmatched names? unexpected skips?), then WRITE:
TENANT_SLUG=swecham node --env-file=.env.production --import tsx \
  scripts/backfill-cycle-anchors.ts path/to/tscc-payment-dates.csv --confirm-prod
```

Operational notes:

- **Idempotent** — an already-anchored cycle skips (`already_anchored`);
  re-running after a partial failure is safe.
- **Skips are reported, never silent**: unmatched/ambiguous names, members
  with no open cycle, future-dated payment dates (the workbook contains at
  least one), duplicate rows (MAX(payment_date) wins).
- **~7 paid-but-undated early-2025 members** are NOT auto-handled — staff
  resolve each (ask TSCC, or fall back to the invoice date by decision) and
  add them to the CSV. **Status: awaiting TSCC data confirmation.**
- Every write emits a `renewal_cycle_reanchored` audit row
  (`invoice_id: null` = the backfill arm) in the same transaction.
- Run AFTER testing completes on the dev branch and AFTER migration 0238 is
  live in prod (decided 2026-07-08).

### Ongoing note — `mark-paid-offline` suppresses the registration fee

F8 (final-review, 2026-07-09): a FIRST payment recorded via the admin
"mark paid offline" action bills at the cycle's FROZEN price and
**suppresses the one-time registration-fee re-bill** (`mark-paid-offline.ts`
threads `frozenPlanPriceThb` into the F4 chain's `renewalSignal`, which
overrides the membership-line price and suppresses the reg-fee line —
mirrors the online confirm-renewal renewal path, which also never re-bills
a registration fee). This is CORRECT for a genuine renewal, but a brand-new
member's very FIRST invoice normally carries a registration fee. **If a
new member's first payment needs a registration fee on the invoice, bill
them via the admin New-invoice form (which does NOT suppress the reg fee)
instead of Renewals → mark paid offline.** Reserve mark-paid-offline for
members whose invoice already exists (issued via New-invoice or a renewal
dispatch) and who simply paid by an offline method (bank transfer, cheque).

## F6 — idempotency sweep (NEW — round-6 staff-review 2026-05-13; handler ships Phase 10 T116)

Purges expired rows from `eventcreate_idempotency_receipts` (7-day
TTL). Without the sweep, the table accumulates ~604,800 rows/year
per tenant at sustained 60 req/min — operationally low but unbounded.

- **Title**: `Chamber-OS · F6 eventcreate idempotency-receipts sweep`
- **URL**: `${BASE}/api/internal/retention/sweep-eventcreate-idempotency`
- **Method**: POST
- **Schedule**: `30 3 * * *` (daily 03:30 Asia/Bangkok)
- **Auth**: `Authorization: Bearer ${CRON_SECRET}`
- **Timeout**: 30 seconds (DELETE ... WHERE ttl_expires_at < NOW() per tenant; bounded at <10k rows/day)
- **Retry on failure**: OFF (handler emits `eventcreate_idempotency_sweep_rows_total{outcome=swept|skipped}` per tenant; the next 24h tick is the natural retry. cron-job.org default retry storm is undesirable.)
- **Expected response codes**:
  - 200 + `swept` count in body → success
  - 401 → `CRON_SECRET` mismatch (rotate + reconfigure)
  - 503 → `FEATURE_F6_EVENTCREATE=false` (expected during dark-launch)
  - 500 → bug or transient DB blip (investigate logs)
- **On-call response**: SLO-F6-004 alerts if `rate(swept) == 0` for ≥2 consecutive days while `tenant_webhook_configs` has live rows. First sweep after flag-flip should report `outcome=swept` rows = (initial table size); steady-state is ~daily-traffic-volume.
- **Handler module**: `src/app/api/internal/retention/sweep-eventcreate-idempotency/route.ts` (Phase 10 T116)

## F6 — non-member PII pseudonymisation sweep (NEW — round-6 staff-review 2026-05-13; handler ships Phase 10 T113)

PDPA Section 37 / GDPR Art. 5(1)(c) data-minimisation: hash
attendee_email + attendee_name on non-member registrations whose
`registered_at` is older than 2 years (FR-032 retention threshold).
Idempotent — re-runs on already-pseudonymised rows are no-ops (the
partial index `event_regs_pseudonymise_eligibility_idx` excludes them).

- **Title**: `Chamber-OS · F6 non-member PII pseudonymisation sweep`
- **URL**: `${BASE}/api/internal/retention/pseudonymise-eventcreate`
- **Method**: POST
- **Schedule**: `0 4 * * *` (daily 04:00 Asia/Bangkok — 30 min after idempotency sweep)
- **Auth**: `Authorization: Bearer ${CRON_SECRET}`
- **Timeout**: 60 seconds (SC-011 target — full-pass <60s at SweCham scale)
- **Retry on failure**: OFF (handler emits `eventcreate_pii_pseudonymisation_sweep_rows_total{outcome=pseudonymised|skipped}`; idempotent — natural daily retry suffices.)
- **Expected response codes**: as above
- **On-call response**: a sustained `outcome=pseudonymised` count of 0 for >30 days when registrations existed older than 2 years indicates a sweep regression. Cross-reference against retention audit (`pii_pseudonymisation_sweep_run` event in audit_log).
- **Handler module**: `src/app/api/internal/retention/pseudonymise-eventcreate/route.ts` (Phase 10 T113)

## F6.1 — error-CSV blob TTL sweep (NEW — F6.1 Phase 5 US5 / T058)

Daily TTL sweep that deletes expired error-CSV blobs (`error_csv_expires_at < NOW()`)
from Vercel Blob storage + clears `error_csv_blob_url` + `error_csv_expires_at` on
the matching `csv_import_records` row. PDPA Section 37 minimization compliance —
the 30-day TTL is set when the import use-case writes the blob; this cron enforces it.

**Lineage**: research.md R6 + critique E5 + operator gate T058 (per spec §
Operational notes). Vercel Hobby plan does NOT host this cron natively
(only 1 daily slot, occupied by F4 outbox purge). cron-job.org owns the
trigger; the handler at `src/app/api/internal/retention/sweep-error-csv-blobs/route.ts`
is the recipient.

### Setup steps (one-time, reproducible)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create job:
   - **Title**: `Chamber-OS · F6.1 error-CSV blob TTL sweep`
   - **URL**: `https://swecham.zyncdata.app/api/internal/retention/sweep-error-csv-blobs`
   - **Method**: GET
   - **Schedule**: `0 22 * * *` UTC (= 05:00 Asia/Bangkok daily)
   - **Headers**:
     - Key: `Authorization`
     - Value: `Bearer ${CRON_SECRET}` (read from Vercel env; ≥16 chars)
   - **Timeout**: 30 seconds (idempotent scan; bounded at limit=100 rows/run)
   - **Retry on failure**: OFF (per F4/F5/F7/F8 convention — the sweep is
     idempotent + the next 24h tick is the natural retry; cron-job.org's
     default retry storm on 500 would hammer the endpoint during a Blob
     outage)
   - **Email alert**: enable "Alert on ≥2 consecutive failures" to the
     maintainer-on-duty inbox (Spec § Operational notes E5 / T058)
3. Commit the cron-job.org job ID to this file (replace `<TODO>` after
   creation): **Job ID: `<TODO — operator fills in after T058 setup>`**

### Expected response codes

| HTTP code | Body | Operator action |
|-----------|------|-----------------|
| 200 + `sweptCount` ≥ 0 | `{ok:true, candidatesScanned, sweptCount, skippedCount, cutoff, durationMs}` | Success — log shows steady-state daily volume |
| 200 + `skippedCount > 0` sustained | Blob delete OR DB clear failed for some rows | Inspect pino `f6_error_csv_sweep_blob_delete_failed` / `f6_error_csv_sweep_clear_failed`; next-day re-run retries |
| 401 | Bearer mismatch | Rotate `CRON_SECRET` in Vercel + update cron-job.org header |
| 500 + `sweep_cron_failed` | Use-case threw at outer level (rare) | Check Vercel runtime logs; manual recovery via § Manual recovery |
| 503 | Currently unreachable — handler does NOT check feature flags (cron always runs) | Should not occur; if observed, investigate |

### Manual recovery

If cron-job.org is offline OR email alert fires for ≥2 consecutive day failures:

```powershell
# Replace YOUR_CRON_SECRET with the value from Vercel env.
curl -X GET `
     -H "Authorization: Bearer YOUR_CRON_SECRET" `
     https://swecham.zyncdata.app/api/internal/retention/sweep-error-csv-blobs
```

The sweep is idempotent. SLA target: blob deletion within 35 days max
(5-day grace beyond the 30-day TTL; PDPA Section 37 minimization still
satisfied). See [eventcreate-csv-import.md § 2](./eventcreate-csv-import.md)
for the full operational runbook.

### Alert rules

- cron-job.org's "consecutive failures ≥ 2" email alert is the primary signal.
- Secondary: `eventcreate_csv_error_csv_downloaded_total{tenant}` rate suddenly
  surging (admins repeatedly fetching error CSVs that should have expired) may
  indicate the sweep is silently failing to delete blobs — cross-reference with
  the `f6_error_csv_sweep_completed` pino info log emit cadence.

### Handler module

`src/app/api/internal/retention/sweep-error-csv-blobs/route.ts` (F6.1 Phase 5 US5 / T050)

---

## Members — reconcile-erasures (NEW — COMP-1 US2d)

Reconciliation sweep that re-drives **stuck member erasures**. GDPR Art.17 /
PDPA §33 member erasure is two-phase: a durable atomic scrub tx (sets
`members.erased_at`) followed by best-effort POST-COMMIT cascades (F1
linked-login erasure, F7 broadcast cancel/content-scrub, F8 renewal cancel, F6
event-registration erasure). `member_erased` is the completion proof — emitted
ONLY when every cascade reports clean. If a cascade fails after the scrub
committed, the member is **stuck**: `erased_at` is set but `member_erased` never
landed. This sweep finds those stuck members
(`MemberRepo.findStuckErasuresInTx`, `FOR UPDATE SKIP LOCKED`) and re-drives the
idempotent `eraseMember` per member (re-attempting only the incomplete cascades).

### What it does

For the resolved tenant, inside `runInTenant`:

1. Select up to **MAX_PER_TICK = 50** stuck members
   (`findStuckErasuresInTx`, `FOR UPDATE SKIP LOCKED` so concurrent ticks +
   slow re-drives don't double-process). The candidate select runs in its OWN
   tx, so the member-row lock drops BEFORE the per-member re-drive loop.
2. Re-drive `eraseMember` per member with system-actor sentinels
   (`actorUserId = 'system:cron'`, `requestId = 'system:erase-reconcile'`) +
   the member's original erasure `reason`.
3. Bucket each outcome → emit `members_erasure_outcome_total{outcome,tenant}`:
   - `reconciled` — `member_erased` emitted this tick (complete).
   - `still_pending` — a cascade is STILL failing (`cascadesComplete=false`) or
     a typed `Result.err` on the re-drive. **TRANSIENT** — next tick retries.
   - `error` — an UNCAUGHT throw from `eraseMember` (genuine bug / DB blip).

### Setup steps (one-time)

1. Sign in to https://cron-job.org with the SweCham ops account.
2. Create new cron-job:
   - **Title**: `Chamber-OS · COMP-1 reconcile-erasures`
   - **URL**: `https://swecham.zyncdata.app/api/cron/members/reconcile-erasures`
   - **Schedule**: `*/30 * * * *` (every 30 minutes — erasure is admin-initiated
     at ~0–2/year, so a stuck erasure is rare; 30 min is a tight-enough loop to
     auto-heal a transient cascade fault within the Art.12 one-month clock,
     while not hammering the endpoint. Matches the reconcile-cadence style of the
     other reconcile crons.)
   - **Request method**: `POST`
   - **Headers**: `Authorization: Bearer <CRON_SECRET>` (reused from F4/F5/F7/F8)
   - **Timeout**: **300 seconds** — set EQUAL to the route's `maxDuration=300`,
     NOT the 60s used by the other crons. **This is load-bearing for
     single-flight** (closes the US2d /code-review #1 concurrent-double-`member_erased`
     window): with retry ON, if the cron-job.org HTTP timeout were shorter than
     the function's actual runtime, a slow tick (many stuck members, each doing
     sequential F1/F6/F7/F8 cascades) would time out at the cron-job.org edge
     and fire a **retry while the original Vercel invocation is still running**.
     The candidate-select's `FOR UPDATE SKIP LOCKED` lock is released before the
     re-drive loop, and `member_erased` is emitted only at the END of each
     member's re-drive — so an overlapping retry tick re-selects the same
     still-stuck members (their `member_erased` has not landed yet) and
     re-drives them concurrently, producing a duplicate `member_erased`
     completion-proof audit row + a double `reconciled` metric. Setting the
     timeout = `maxDuration` makes cron-job.org WAIT for the function to return
     (Vercel hard-kills it at 300s regardless), so a retry only ever fires
     AFTER the tick has fully returned — by which point the completed members'
     `member_erased` rows have landed and the anti-join (`NOT EXISTS member_erased`)
     excludes them, so the retry is sequential and re-drives only the genuinely
     still-stuck members. **Operator: configure this cron's timeout to 300s, not
     the boilerplate 60s.**
   - **Retry on failure**: **ON** — UNLIKE the F7/F8 idempotent housekeeping
     crons. The route returns **500 ONLY when an uncaught throw occurred this
     tick** (`summary.error > 0`), and a 500 is a genuinely-broken tick worth
     retrying. A tick of pure `still_pending` returns **200** (the expected
     steady state until the operator fixes the failing cascade) so a transient
     stuck-erasure does NOT trigger a retry-storm. The 300s timeout above means
     a 500-triggered retry runs AFTER the prior tick returned, never concurrently.
   - **Notifications**: email on ≥3 consecutive failures
3. Click **Run** to verify a 200 OK response:
   ```json
   { "processed": 0, "reconciled": 0, "still_pending": 0, "error": 0 }
   ```
   All-zero is the expected steady state (no stuck erasures pending).

### Kill-switch

`FEATURE_MEMBER_ERASURE_RECONCILE` (default `true`). When `false`, the route
returns **200 + `{ skipped: true, reason: 'feature_disabled' }`** (NOT 503) so
cron-job.org does not retry-storm during a pause window.

### Expected response codes

| HTTP code | Body | Operator action |
|-----------|------|-----------------|
| 200 + all-zero summary | `{ processed:0, reconciled:0, still_pending:0, error:0 }` | Healthy steady state (nothing stuck) — None |
| 200 + `reconciled > 0` | A stuck erasure completed this tick | None — expected after a transient cascade fault clears |
| 200 + `still_pending > 0`, `error: 0` | A cascade is STILL failing — TRANSIENT, retried next tick | Inspect the per-cascade pino error (`erase-member: <cascade> not clean / threw`). If sustained over ≥3 ticks → alarm (see § Alert rules). **If accompanied by a `last_admin` signal → manual operator action (see below).** |
| 500 + `error > 0` | An uncaught throw from `eraseMember` (bug / DB blip) | Harness retries. Inspect `cron.members.reconcile_erasures.uncaught` (stack). |
| 200 + `{ skipped: true, reason: 'feature_disabled' }` | `FEATURE_MEMBER_ERASURE_RECONCILE=false` | Expected during a pause; do nothing. |
| 401 | Bearer mismatch | Rotate `CRON_SECRET`; reconfigure cron-job.org header |
| 500 + `{ error: { code: 'internal_error' } }` | The candidate-select query threw | Investigate DB connectivity; harness retries next tick |

### Alert rules

- `members_erasure_outcome_total{outcome="still_pending"}` rate > 0 sustained
  over ≥3 consecutive ticks → page DPO/on-call. The Art.17/§33 erasure is NOT
  completing; inspect the failing cascade's pino error. Once the underlying
  fault clears, the next tick auto-completes (no manual data action).
- `members_erasure_outcome_total{outcome="error"}` sustained over ≥3 ticks
  (the tick also 500s) → page on-call. A real bug or DB outage.

### Last-admin manual remediation (the NON-retryable case)

The ONE stuck-erasure case the reconciler **cannot self-heal**: when the erased
member's contact is the **last active admin** for the tenant, the F1
linked-login erasure cascade hits the `users_last_admin_protection` trigger,
`eraseUser` returns `'erase-user-last-admin'`, and the cascade emits the
distinct `auth_erase_cascade_outcome_total{outcome="last_admin"}` metric. The
reconciler re-drives it **every tick** and it recurs as `still_pending`
**forever** — because re-driving the SAME erasure cannot remove the last-admin
constraint. Alert on the `last_admin` signal SEPARATELY from a transient
`still_pending` (see `docs/observability.md § 14.8.3`). Remediation is a
**manual, non-retryable operator action**:

1. Promote or transfer ANOTHER user to the `admin` role (so the erased member's
   login is no longer the last admin).
2. The NEXT reconciler tick then completes the erasure normally (no further
   action). Re-running the cron WITHOUT step 1 is futile — it will recur as
   `still_pending`/`last_admin` indefinitely.

### Handler module

`src/app/api/cron/members/reconcile-erasures/route.ts`

---

## F9 — insights (dashboard snapshot + export worker)

Two cron coordinators keep the F9 admin dashboard fresh and process async
directory/GDPR export artefacts. Both: `POST`, Bearer `CRON_SECRET`
(constant-time), Node runtime, **retry OFF** (idempotent), and return **200**
when `FEATURE_F9_DASHBOARD=false` (`{ skipped: true }`) so a dark launch never
retry-storms.

| Schedule | Endpoint | Purpose |
|----------|----------|---------|
| `*/5 * * * *` | `/api/cron/insights/snapshot-refresh-coordinator` | recompute `dashboard_metrics_cache` (FR-005 freshness; single-tenant MVP) |
| `*/5 * * * *` | `/api/cron/insights/process-export-jobs` | claim+build E-Book/JSON (US5) / GDPR (US6) jobs → private Blob; reclaim stuck `processing` (>10 min); TTL-sweep `ready\|delivered` past `expires_at` (delete Blob → `expired`) |

### Setup steps (cron-job.org, one-time)

1. Two jobs, schedule `*/5 * * * *`, method `POST`, header
   `Authorization: Bearer $CRON_SECRET`, retries **0**, timeout 60 s.
2. Verify each returns `{ skipped: true }` while `FEATURE_F9_DASHBOARD=false`,
   then `{ refreshed: 1 }` / `{ processed, reclaimed, expired }` once flipped on.

### ⚠️ Ship-day operator gate — private Blob store (T101a)

The export worker + download proxy store E-Book / GDPR artefacts via
`put({ access: 'private' })`. A Vercel Blob store is **public XOR private**
(chosen at store creation — the dashboard offers exactly one access mode). The
existing `BLOB_READ_WRITE_TOKEN` store is **public** — it backs F4 invoice PDFs
**and** F9 directory logos, all uploaded with `access:'public'` — so private
export puts on it are rejected (`"Cannot use private access on a public store"`).
A **second, dedicated private store** is therefore required. Before flipping
`FEATURE_F9_DASHBOARD` on in any environment that exercises exports:

1. **Vercel dashboard → Storage → Create** a new Blob store, choosing
   **Private** access. (Or CLI: `vercel blob create-store <name> --access private`.)
2. Copy its read/write token into **`BLOB_PRIVATE_READ_WRITE_TOKEN`** (Production
   + Preview). Leave `BLOB_READ_WRITE_TOKEN` pointed at the existing public store
   — F4 PDFs + F9 logos must stay public (they appear in published outputs).
3. Set `EXPORT_DOWNLOAD_TOKEN_SECRET` (≥32 bytes; distinct from auth/unsubscribe).
4. Smoke-test: generate a directory JSON on `/admin/directory` → wait for the
   `process-export-jobs` tick → download via the "Download" link (the staff
   prepare-and-redirect route mints a single-use token → private proxy streams).

**Code wiring (done — commit on `015-admin-dashboard`):** `private-blob-adapter.ts`
reads `env.blob.privateReadWriteToken`, which is `BLOB_PRIVATE_READ_WRITE_TOKEN`
falling back to `BLOB_READ_WRITE_TOKEN` when unset — so dev/test/dark-launch boot
without a private store (exports use an in-memory stub in tests and are
flag-gated in prod). The only ship-day action is **provisioning the private store
+ setting the two env vars**; no further code change. F4 invoice PDFs + F9 logos
are untouched (still on the public store).

### Handler modules

`src/app/api/cron/insights/snapshot-refresh-coordinator/route.ts` ·
`src/app/api/cron/insights/process-export-jobs/route.ts` ·
download proxy `src/app/api/internal/exports/[jobId]/download/route.ts`.

---

## Owner

Platform on-call (default: maintainer). Per-feature ownership escalates
via the linked detail runbooks for the affected job.
