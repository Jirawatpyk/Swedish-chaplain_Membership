# Phase 0 Research — F9 Admin Dashboard + Directory + Timeline + Audit

**Branch**: `015-admin-dashboard` | **Date**: 2026-05-25
**Inputs**: `spec.md` (incl. 9 resolved clarifications), constitution v1.4.2,
infrastructure map (latest migration **0184** → F9 starts at **0185**).

All Technical-Context unknowns are resolved below. No `NEEDS CLARIFICATION` remain.

---

## R1 — Dashboard derived-metric storage & refresh

- **Decision**: A **per-tenant cache table** `dashboard_metrics_cache` (one row per
  tenant, JSONB `metrics` payload + `computed_at`), refreshed by a cron coordinator
  every ~5 min and **partially refreshed on key events** (payment recorded, broadcast
  approved, member status change) by enqueuing/marking the tenant row stale. The
  dashboard reads the single cached row (fast, bounded) and shows `computed_at` as the
  "as of" time (FR-005).
- **Rationale**: Meets SC-002 (p95 < 1.5 s @ 5k) by avoiding a 6-source recompute per
  load. Drizzle-native (no raw matview to hand-manage), RLS-compatible, supports
  event-triggered partial updates, and avoids `REFRESH MATERIALIZED VIEW` exclusive-lock
  contention.
- **Alternatives rejected**: (a) **Materialized view** — Drizzle can't emit/manage it,
  no partial event refresh, `REFRESH CONCURRENTLY` needs a unique index + still heavy;
  (b) **Fully live query per load** — violates SC-002 at scale; (c) **Nightly batch** —
  too stale for an operations dashboard.
- **Activity feed (live, not cached)** — the recent-activity feed (FR-003) is served by
  a **lightweight live query** of the last N audit events for the tenant, separate from
  the cached KPI snapshot. Only the *counts/KPIs* live in `dashboard_metrics_cache`; the
  feed stays near-real-time (a just-occurred event appears immediately) and the snapshot
  job stays small/fast (no activity-feed churn). (Critique X2/P2.)
- **Cold-start** — before the first snapshot refresh (new tenant), there is no cache
  row. The dashboard MUST **lazily compute the snapshot on first read** (then cache it),
  or render a friendly "computing…" empty state — never a raw `snapshot_unavailable`
  error (FR-006). `snapshot_unavailable` is reserved for genuine compute failures, which
  fall back to the empty state + a retryable signal. (Critique E3.)

## R2 — Benefit usage computation (per member, per year)

- **Decision**: Compute **live per member** on the benefit page (single-member queries
  are cheap): read entitlements from `membership_plans.benefitMatrix` (JSONB), count
  E-Blast consumption from `broadcasts` (status sent, `requested_by_member_id`, quota
  year) and cultural/event-ticket consumption from `event_registrations`
  (`countedAgainstCulturalQuota = true`, joined to `events.start_date` year). The
  dashboard's aggregate "benefits under-delivered" count is computed in the **snapshot
  job** (R1), not live.
- **Rationale**: Per-member live compute is bounded and always fresh; only the
  cross-member aggregate needs caching. Reuses existing columns (no schema change for
  consumption). Under-use warning = `(elapsedYear% − consumed%) ≥ 25pp` (spec FR-021).
- **Alternatives rejected**: materialized `benefit_usage_v` per member-year — premature
  (single-member reads don't need it; Constitution X).

## R3 — Engagement Score

- **Decision**: `engagementScore = 100 − members.riskScore` (F8 risk is 0–100 where
  higher = worse), with bands inverted from `riskScoreBand`
  (`critical→critical, at-risk→warning, warning→moderate, healthy→healthy`). **No new
  column, no new pipeline** — projected on read from the existing F8 fields. Member-list
  sort/filter reuses the existing `?risk_band=` query param and the F8 recompute cron
  keeps it fresh.
- **Rationale**: Spec Q1 (clarify pass 2) + smart-features doc: #15 is "the inverse of
  at-risk, same data, positive framing." Reusing F8 honours Simplicity (Principle X) and
  avoids a duplicate scorer. Staff-facing only (FR-007a).
- **Alternatives rejected**: a standalone #15 composite (30/25/20/15/10 weights) — would
  duplicate F8's scoring inputs and create drift between two "health" numbers.

## R4 — Multi-source member timeline

- **Decision**: A hand-authored SQL view **`member_timeline_v`** with
  `WITH (security_invoker = on)`, `UNION ALL` over six sources normalised to a common
  shape `(tenant_id, member_id, occurred_at, source, ref_id, summary_key, payload)`:
  audit_log (existing), invoices, payments, event_registrations, broadcasts, renewal
  events. Keyset pagination on `(occurred_at DESC, ref_id DESC)`. The existing
  `timelineList` use-case **keeps its signature + role-redaction**; only its
  infrastructure repo (`drizzle-timeline-repo.ts`) is swapped to read the view. Filters
  (source type, date range, actor) become `WHERE` predicates.
- **Rationale**: A DB-side `UNION ALL` reuses each base table's indexes and makes keyset
  pagination correct across heterogeneous sources; `security_invoker = on` ensures the
  querying `chamber_app` role's RLS applies per base table (tenant isolation holds
  inside the view). Redaction stays in the application layer (single source of truth,
  already tested).
- **Alternatives rejected**: (a) per-source paginated queries merged in app code —
  cursor correctness across 6 streams is fragile; (b) a denormalised `timeline_events`
  table fed by triggers — write amplification + backfill risk for data already in source
  tables (Constitution X).
- **Risk note**: `security_invoker` requires PG15+. Neon `ap-southeast-1` is PG15/16 →
  supported. A CI guard (`check-f9-schema`) asserts the view is `security_invoker`.

## R5 — Async export jobs (E-Book + GDPR archive)

- **Decision**: An `export_jobs` table with a state machine
  `requested → processing → ready → delivered → expired | failed` + an **idempotency
  key** (`tenant_id, kind, subject_member_id, requested_for_period`) so a retry never
  produces a duplicate artefact. A cron worker (`process-export-jobs`) claims queued
  jobs (per-tenant advisory lock), generates the artefact, uploads to **private** Blob,
  sets `ready` + signed-token + expiry, and notifies the requester. Audit exports (US2)
  are **synchronous** streams (small); E-Book + GDPR archive are **async** (spec FR-037
  hybrid).
- **Rationale**: Matches the resolved hybrid delivery model; reuses the F8/F6
  coordinator→worker cron pattern + `verifyCronBearer`. State machine + idempotency
  satisfy Principle VIII.
- **Stuck-`processing` reclaim (Critique E2)**: a worker crash can leave a job in
  `processing` forever. The worker sweep MUST reclaim jobs whose `refresh_started_at` /
  claim is older than a timeout — transitioning `processing → failed` (or back to
  `requested` for a bounded number of retries) and emitting a metric. This mirrors F7's
  `reconcile-stuck-sending`.
- **Alternatives rejected**: synchronous generation in the request (timeout risk for
  multi-file archives); a third-party queue (no new infra — Constitution X);
  no reclaim (jobs wedge in `processing` on crash — rejected, Principle VIII).

## R6 — Private artefact delivery

- **Decision**: Upload E-Book + GDPR archives to **private** Vercel Blob (not
  `access:'public'`). Deliver via an authenticated route
  `GET /api/internal/exports/[jobId]/download` that (a) requires a valid session, (b)
  authorises the caller (the subject member, or an admin of the same tenant), (c)
  validates a short-lived signed token bound to `jobId` + expiry (`EXPORT_DOWNLOAD_TOKEN_SECRET`,
  ≥32 bytes, distinct from other secrets), then streams the Blob. The Blob URL is never
  exposed to the client.
- **Rationale**: GDPR archives + E-Book bundle PII; F4's public content-addressed Blob
  is unacceptable here (leak on URL disclosure). Private storage + authn proxy + signed
  expiring token = defence in depth.
- **✅ Resolved (Critique E9, verified 2026-05-25 via Vercel Storage docs)**: the
  `@vercel/blob` v2 API **supports `access: 'public' | 'private'`** on `put()` (private
  is the current default), and `get(urlOrPathname, { access: 'private', useCache: false })`
  streams a private object server-side. So R6's private-delivery model is supported by
  the existing dependency line. **Action at implementation**: confirm the installed
  `@vercel/blob@2.3.3` TS types expose the `'private'` literal; if a patch predates it,
  bump **within `^2`** (a version bump, *not* a new dependency — the "no new deps" claim
  holds). The F9 private adapter uses `put(..., { access:'private', addRandomSuffix:true })`
  and reads via the authenticated proxy with `get(..., { access:'private', useCache:false })`.
- **Token reuse (Critique E4)**: the download token is **single-use** — invalidated when
  the job transitions to `delivered`; a re-download requires a fresh authenticated
  request that mints a new short-lived token. TTL is short (e.g. ≤ 1 h). This bounds the
  blast radius of a leaked link to a single fetch within a short window.
- **Alternatives rejected**: public Blob + obscure key (security-by-obscurity, fails
  Principle I); emailing the archive as an attachment (size + retention risk);
  reusable-until-expiry token (replayable on link leak — rejected for a PII archive).

## R7 — Audit log viewer (read side)

- **Decision**: Add a read-only `audit-query` use-case to the **`auth` module**
  (it owns the `audit_log` schema), exposed via the auth barrel. Supports filters
  (event type, actor, target/entity, date range), keyset pagination on
  `(timestamp DESC, id DESC)`, role-based payload redaction (reuse the projection idea
  from `timeline-list`), and a synchronous filtered export. The F9 audit page in
  `(staff)/admin/audit` consumes it. No write path; the log stays append-only.
- **Rationale**: Keeps `audit_log` ownership in `auth` (Principle III — don't reach into
  another module's table from `insights`). Read-only viewer satisfies FR-010/Principle VIII.
- **Alternatives rejected**: querying `audit_log` directly from `insights` (boundary
  violation); a generic admin SQL console (security risk, out of scope).

## R8 — Dashboard visualisation without a charting dependency

- **Decision**: Render KPIs as shadcn cards; trends/bars as **accessible inline SVG**
  (or CSS bars) with a visually-hidden `<table>` data equivalent. No charting library.
- **Rationale**: Constitution X (no speculative deps) + Principle VI (charts must be
  screen-reader accessible — canvas libraries often aren't). The MVP dashboard needs
  counts, small bars, and a sparkline at most.
- **Alternatives rejected**: `recharts`/`visx`/`chart.js` — new dependency + a11y +
  bundle cost not justified for the MVP metric set; revisit only if a real multi-series
  charting need emerges.

## R9 — Smart-insight catalogue

- **Decision**: A **fixed catalogue of ≥3 insight rules** (FR-004) computed in the
  snapshot job: (1) members with unused E-Blast quota, (2) members with under-used
  event/cultural tickets, (3) at-risk members needing follow-up. Each insight has a
  stable `insight_key`; dismissals are stored in `smart_insight_dismissals`
  (`tenant_id, insight_key, scope_ref, dismissed_by, dismissed_at`) and suppress the
  insight for the current cycle. No generic rule engine.
- **Rationale**: Bounds scope + gives one acceptance test per rule (clarify Q4).
- **Alternatives rejected**: extensible rule DSL/engine (#19) — deferred; Constitution X.

## R10 — Lawful basis & retention (PDPA + GDPR) per surface

- **Decision (record of processing)**:
  - **Dashboard / Audit viewer / Timeline (staff reads of PII)** — lawful basis:
    legitimate interest (chamber administration & oversight) + legal obligation for the
    audit trail. Retention: audit per existing `audit_log.retention_years` (5/10y).
  - **GDPR export** — lawful basis: legal obligation (GDPR Art. 20 / PDPA portability).
    The generated archive is transient: artefact + signed link **expire** (TTL) and the
    Blob object is swept after expiry; `export_jobs` row retained for audit (no PII
    payload, just metadata).
  - **Directory listings** — lawful basis: consent (opt-in, default private); members
    control field exposure; opt-out reflected immediately in new outputs.
  - **PII-read auditing** — member-detail views + every export are audit-logged (FR-036)
    with actor, subject, request-id (no PII payload in logs/metrics).
- **Rationale**: Satisfies Principle I documented-lawful-basis requirement and the
  DPIA-style reasoning expected for an all-PII feature.

## R11 — Feature flag & rollout

- **Decision**: Ship behind `FEATURE_F9_DASHBOARD` (default off); `/admin` keeps the
  current placeholder until flip. New env: `FEATURE_F9_DASHBOARD`,
  `EXPORT_DOWNLOAD_TOKEN_SECRET`. Reuse `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`. All env
  validated in `src/lib/env.ts` (zod) at boot.
- **Rationale**: Matches F4/F5/F7 kill-switch pattern; lets snapshot cron + tables ship
  dark before the UI flips.

## R12 — Observability additions

- **Decision**: New OTel instruments (cardinality-safe, tenant-id label only):
  `insights.snapshot_refresh_duration_ms` (histogram), `insights.snapshot_age_seconds`
  (gauge), `insights.export_job_queue_depth` (gauge), `insights.export_job_duration_ms`
  (histogram, labelled by kind), `insights.audit_query_duration_ms` (histogram). SLOs +
  alerts added to `docs/observability.md`. A `cross_tenant_probe` audit event is a
  high-severity signal (Principle I §4).
- **Rationale**: Principle VII — measure the new hot paths and the snapshot freshness
  that SC-002/FR-005 depend on.

---

### Resolved decisions summary

| # | Topic | Decision |
|---|-------|----------|
| R1 | Dashboard storage | Per-tenant `dashboard_metrics_cache` table, ~5 min cron + event-triggered refresh |
| R2 | Benefit usage | Live per-member from `benefitMatrix` + broadcast/event consumption; aggregate in snapshot |
| R3 | Engagement Score | `100 − riskScore` projection from F8; no new pipeline; staff-only sortable/filterable |
| R4 | Timeline | `member_timeline_v` `security_invoker` UNION-ALL view; same use-case + redaction; keyset paginate |
| R5 | Export jobs | `export_jobs` state machine + idempotency; cron worker; audit export sync, E-Book/GDPR async |
| R6 | Private delivery | Private Blob + authenticated proxy route + signed expiring token (`EXPORT_DOWNLOAD_TOKEN_SECRET`) |
| R7 | Audit viewer | Read-only `audit-query` use-case in `auth` barrel; keyset paginate; role redaction |
| R8 | Charts | Accessible inline SVG/CSS + hidden table; no charting dependency |
| R9 | Insights | Fixed ≥3-rule catalogue in snapshot job + `smart_insight_dismissals` |
| R10 | Lawful basis | Documented per surface (legitimate interest / legal obligation / consent / Art.20) |
| R11 | Rollout | `FEATURE_F9_DASHBOARD` kill-switch (default off); ships dark |
| R12 | Observability | 5 new OTel instruments + SLOs; cross-tenant probe = high-severity audit |
