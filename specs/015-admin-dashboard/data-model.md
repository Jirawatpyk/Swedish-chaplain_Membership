# Phase 1 Data Model — F9 Admin Dashboard + Directory + Timeline + Audit

**Branch**: `015-admin-dashboard` | **Date**: 2026-05-25
**Migrations start at**: `0185` (latest existing = `0184`).

All new tables are **tenant-scoped** (`tenant_id text NOT NULL`) with **RLS + FORCE
ROW LEVEL SECURITY** and a policy `USING (tenant_id = current_setting('app.current_tenant', true))`.
All timestamps are `timestamptz` stored in **UTC** (Gregorian). Access is always via
`runInTenant(ctx, tx)` — never the global `db` (CLAUDE.md RLS gotcha).

---

## 1. `dashboard_metrics_cache` (new) — US1 / R1

One row per tenant; the cached operations-dashboard snapshot.

| Column | Type | Notes |
|--------|------|-------|
| `tenant_id` | `text` PK | one row per tenant; RLS key |
| `metrics` | `jsonb NOT NULL` | typed `DashboardSnapshot` (counts, YTD revenue, needs-attention, under-delivered-benefit count, top insights, **`revenueTrend[12]`** {month, satang} + **`memberGrowth[]`** {month, cumulative} + current status breakdown — FR-001a charts; computed in the snapshot job, no per-load aggregation) |
| `computed_at` | `timestamptz NOT NULL` | the "as of" time shown in UI (FR-005) |
| `stale` | `boolean NOT NULL DEFAULT false` | set true by event-triggers; coordinator prioritises stale rows |
| `refresh_started_at` | `timestamptz` | claim marker to avoid concurrent refresh |

- **RLS + FORCE**; index: PK on `tenant_id` is sufficient (single-row read).
- `metrics` JSONB is a **derived projection**, never authoritative; safe to rebuild.
- **Validation**: `computed_at ≤ now()`; snapshot rebuild is idempotent.

## 2. `smart_insight_dismissals` (new) — US1 / R9

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `tenant_id` | `text NOT NULL` | RLS key |
| `insight_key` | `text NOT NULL` | stable catalogue key (`unused_eblast_quota`, `underused_event_tickets`, `at_risk_followup`) |
| `scope_ref` | `text` | optional member_id / segment the insight referenced |
| `dismissed_by` | `uuid NOT NULL` | actor user id |
| `dismissed_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `cycle_key` | `text NOT NULL` | suppression window (e.g. membership year / week) — insight re-surfaces in a new cycle |

- **RLS + FORCE**; unique `(tenant_id, insight_key, scope_ref, cycle_key)` to make
  dismissal idempotent.
- **Validation**: `insight_key` ∈ fixed catalogue (Domain enum).
- **`cycle_key` semantics are per-insight** (critique L3): quota-based insights
  (`unused_eblast_quota`, `underused_event_tickets`) use the **membership year**
  (calendar year, tenant TZ); the recurring `at_risk_followup` insight uses the
  **ISO week** so a dismissal suppresses it for that week only. The Domain catalogue
  declares each insight's cycle granularity.

## 3. `directory_listings` (new) — US5 / R-spec FR-025

One row per member; visibility + per-field exposure. **Default private.**

| Column | Type | Notes |
|--------|------|-------|
| `tenant_id` | `text NOT NULL` | RLS key |
| `member_id` | `uuid NOT NULL` | FK → `members.member_id`; PK with tenant_id |
| `listed` | `boolean NOT NULL DEFAULT false` | opt-in to be listed |
| `field_visibility` | `jsonb NOT NULL DEFAULT '{}'` | per-field toggle for the fixed set: `name, tier, industry, description, website, logo, location, contact_name, contact_email` (email default hidden) |
| `industry` | `text` | category/free-text (member-editable directory metadata) |
| `description` | `text` | short blurb (length-capped) |
| `website` | `text` | URL (validated scheme http/https) |
| `logo_blob_key` | `text` | optional logo (re-encoded/EXIF-stripped like F4) |
| `location_city` | `text` | |
| `location_country` | `text` | ISO 3166-1 (reuse `i18n-iso-countries`) |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |

- **RLS + FORCE**; PK `(tenant_id, member_id)`.
- **Validation**: `field_visibility` keys ⊆ fixed field set (Domain `DIRECTORY_FIELDS`);
  `website` scheme allow-list; `description` length cap; email hidden unless explicitly
  toggled on. Published outputs (E-Book/JSON) include a member **only if `listed=true`**
  and only the fields with `field_visibility[field] = true`.
- **Identity**: name/tier/contact_name are sourced live from `members`/`contacts` (not
  duplicated) — `directory_listings` stores only directory-specific metadata + toggles.

## 4. `export_jobs` (new) — US5 (E-Book) + US6 (GDPR) / R5

Tracks asynchronous artefact generation. Holds **no PII payload** — only metadata +
the private Blob key.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `tenant_id` | `text NOT NULL` | RLS key |
| `kind` | `export_kind` enum | `gdpr_member_archive` \| `directory_ebook` \| `directory_json` \| `audit_export` (large audit exports over the sync cap, critique R2-E2) |
| `subject_member_id` | `uuid` | the data subject (GDPR); null for directory-wide |
| `requested_by` | `uuid NOT NULL` | actor (member self, or admin) |
| `requested_for_period` | `text` | e.g. membership year (idempotency component) |
| `status` | `export_status` enum | `requested` \| `processing` \| `ready` \| `delivered` \| `expired` \| `failed` |
| `idempotency_key` | `text NOT NULL` | `hash(tenant_id,kind,subject_member_id,requested_for_period)`; unique |
| `blob_key` | `text` | private Blob object key (set when `ready`) |
| `download_token_hash` | `text` | hash of the short-lived signed token |
| `expires_at` | `timestamptz` | artefact + link TTL (FR-030) |
| `error_code` | `text` | set on `failed` |
| `created_at` / `updated_at` | `timestamptz NOT NULL` | |

- **RLS + FORCE**; unique `(tenant_id, idempotency_key)`; index `(tenant_id, status)`
  for the worker claim query.
- **State machine** (Domain-enforced; illegal transitions rejected):

```text
requested ──claim──▶ processing ──ok──▶ ready ──download──▶ delivered ──ttl──▶ expired
     │                   │                                       │
     └───────────────────┴────────────── error ────────────────▶ failed
```

  - `requested→processing`: worker claims under per-(tenant,job) advisory lock.
  - `processing→ready`: artefact uploaded to private Blob; token hash + `expires_at` set.
  - `ready→delivered`: first successful authenticated download.
  - `ready|delivered→expired`: TTL sweep; Blob object deleted.
  - `*→failed`: error captured; surfaced to requester (FR-037, no silent failure).
  - **`processing→failed` reclaim** (Critique E2): the worker sweep reclaims jobs whose
    claim (`refresh_started_at`/`updated_at`) is older than a timeout — preventing a
    crashed worker from wedging a job in `processing` forever. Bounded retries may route
    `processing→requested` instead; exhausted retries → `failed`. Emit a reclaim metric.
- **Idempotency**: a duplicate request with the same `idempotency_key` returns the
  existing job rather than generating a second archive (Principle VIII).

## 5. `member_timeline_v` (new SQL view) — US3 / R4

`CREATE VIEW member_timeline_v WITH (security_invoker = on) AS` `UNION ALL` of six
sources normalised to:

| Column | Type | Source mapping |
|--------|------|----------------|
| `tenant_id` | `text` | each base table |
| `member_id` | `uuid` | audit `payload->>'member_id'` · invoices/payments/regs/broadcasts member fk · members |
| `occurred_at` | `timestamptz` | event timestamp / invoice_date / payment_date / event start / sent_at / risk computed_at |
| `source` | `text` | `audit` \| `invoice` \| `payment` \| `event` \| `broadcast` \| `renewal` |
| `ref_id` | `uuid` | the source row id (cursor tiebreaker) |
| `actor_kind` | `text` | `staff` \| `member` \| `system` (for the actor filter) |
| `payload` | `jsonb` | minimal source-specific detail (redactable) |

> **`summary_key` is NOT a SQL column (critique R2-E3)**: the view emits `source` +
> `payload` only; the **application layer** maps `(source, payload)` → an i18n key +
> interpolation values for localized rendering (FR-034). Legacy `audit_log.summary`
> strings are a fallback display value for `source='audit'` rows lacking a key mapping.

- **`security_invoker = on`** → base-table RLS applies to the querying `chamber_app`
  role (tenant isolation holds inside the view). CI guard asserts this.
- **Pagination**: keyset on `(occurred_at DESC, ref_id DESC)`; default page 50, max 100
  (matches existing `timelineList`).
- **Redaction**: applied in `timeline-list` use-case (existing logic — strips
  `override_reason_*`, `notes` for non-admin). Unchanged.
- **No new base columns** — the view reads existing fields.

## 6. Engagement Score (derived, no storage) — US1 / R3

Projected on read; **no column**:

```
engagementScore = clamp(100 − members.risk_score, 0, 100)   // null risk → null score
engagementBand  = invert(members.risk_score_band)
                  critical→critical · at-risk→warning · warning→moderate · healthy→healthy
```

- Member-list sort = order by `members.risk_score` (ASC risk = DESC engagement);
  filter reuses existing `?risk_band=`. Staff-only (FR-007a).
- **Null handling (Critique E10)**: `risk_score` is null until F8's at-risk cron runs
  for a tenant → engagement is null. The member-list column displays "—" for null,
  sorts nulls **last** (regardless of direction), and the engagement-band filter
  excludes nulls. An un-scored tenant therefore never gets a broken/empty sort.

## 7. New audit event types (F9) — Principle VIII

Owned by the new `insights` audit port (plus the read-side events). 5-year default
retention (no financial/tax records here).

| Event type | Emitted when |
|------------|--------------|
| `dashboard_viewed` | staff opens the operations dashboard (PII-read context) |
| `audit_log_queried` | staff runs an audit-viewer query (who queried the audit log) |
| `audit_log_exported` | staff exports a filtered audit set (FR-012) |
| `member_benefit_viewed` | staff opens a member's benefit view (PII read, FR-036) |
| `smart_insight_dismissed` | an insight is dismissed |
| `directory_listing_updated` | a member changes visibility/field exposure |
| `directory_ebook_generated` | E-Book artefact produced |
| `directory_json_exported` | directory JSON export produced |
| `data_export_requested` | GDPR export requested (by member or admin-on-behalf) |
| `data_export_generated` | archive produced |
| `data_export_downloaded` | archive downloaded via the authenticated proxy |
| `data_export_failed` | export job failed |
| `data_export_expired` | artefact + link TTL-swept |
| `insights_cross_tenant_probe` | a cross-tenant access attempt (high-severity, Principle I §4) |

- The audit-viewer **read** path emits `audit_log_queried`/`audit_log_exported` only
  (it never mutates `audit_log`).

## 8. Entity relationships (summary)

```text
members (F3) 1───1 directory_listings (F9)        // optional opt-in row per member
members.risk_score (F8) ──project──▶ EngagementScore (F9, derived, no storage)
membership_plans.benefitMatrix (F2) ┐
broadcasts (F7, requested_by_member) ├─compute──▶ BenefitUsage (F9, derived, live)
event_registrations (F6, cultural)  ┘
audit_log (F1) ──read──▶ audit-query (auth) + activity feed (snapshot) + timeline view
{invoices,payments,events,broadcasts,renewals,audit} ──UNION──▶ member_timeline_v (F9)
export_jobs (F9) ──artefact──▶ private Blob ──proxy──▶ authenticated download
dashboard_metrics_cache (F9) ◀──refresh── cron snapshot job (reads all source modules)
smart_insight_dismissals (F9) ──suppresses──▶ insights in dashboard_metrics_cache.metrics
```

## 9. Migration plan (0185+)

1. `0185_f9_dashboard_metrics_cache.sql` — table + RLS+FORCE + policy.
2. `0186_f9_smart_insight_dismissals.sql` — table + RLS+FORCE + unique.
3. `0187_f9_directory_listings.sql` — table + RLS+FORCE + FK to members.
4. `0188_f9_export_jobs.sql` — enums (`export_kind`, `export_status`) + table + RLS+FORCE
   + unique idempotency + status index.
5. `0189_f9_member_timeline_view.sql` — `CREATE VIEW member_timeline_v WITH
   (security_invoker = on)` + **the full per-source keyset index set** (Critique E6 —
   load-bearing for SC-005 and timeline pagination; do NOT leave as "if missing"):
   - `invoices(tenant_id, member_id, invoice_date DESC)`
   - `payments(tenant_id, member_id, payment_date DESC)`
   - `event_registrations(tenant_id, matched_member_id, …)` joined to `events(start_date)`
     — add `events(tenant_id, start_date DESC)` if absent
   - `broadcasts(tenant_id, requested_by_member_id, sent_at DESC)`
   - renewal events source index `(tenant_id, member_id, occurred_at DESC)`
   - audit member-timeline index `audit_log((payload->>'member_id'), timestamp DESC)`
     (extend the existing `audit_log_member_id_idx` to include `timestamp` if needed)
6. `0190_f9_audit_query_indexes.sql` — composite indexes on `audit_log`
   `(tenant_id, event_type, timestamp DESC)` and `(tenant_id, actor_user_id, timestamp DESC)`
   to keep the audit viewer interactive at tens of thousands of rows, **plus
   `(tenant_id, timestamp DESC)`** for the live dashboard activity-feed scan (critique
   R2-E4).
7. `0191_f9_audit_event_types.sql` — **`ALTER TYPE <audit_event_type> ADD VALUE …`** for
   the 14 new F9 audit event types (§7). **REQUIRED before any code emits F9 events**
   (analyze H1) — mirrors F8's enum extension; `check:audit-events` validates enum ↔
   taxonomy. Postgres requires `ADD VALUE` in its own migration (not the same tx as first
   use), so this is a standalone migration. **No ordering dependency with 0190**: the 0190
   stale-trigger keys off **pre-existing** F3/F4/F5/F7 event types (member status change,
   payment recorded, broadcast approved) — not the new F9 types — so it is valid whether
   or not 0191 has run (critique R2-L1).

> **Index verification (Critique E6)**: an `EXPLAIN`-backed perf test MUST confirm both
> the timeline view query and the audit query use index scans (no full-table sort) at
> the SC-002 5,000-member scale before the Verify gate.
>
> **Cursor-correctness test (Critique E7)**: a named integration test MUST seed two
> events with an **identical `occurred_at` from different sources** and assert the
> keyset `(occurred_at DESC, ref_id DESC)` cursor paginates them with no loss or
> duplication across the page boundary.
>
> **Rollback SQL (Critique E8)**: drizzle-kit is forward-only, so each raw-SQL artefact
> (view, RLS policies, enums) MUST ship a documented inverse (`DROP VIEW member_timeline_v;`
> `DROP POLICY … ; ALTER TABLE … DISABLE ROW LEVEL SECURITY;` `DROP TYPE export_kind/export_status;`)
> in the migration's companion notes for a clean rollback during a bad deploy.
>
> **Cross-module SQL coupling (Critique E1)**: `member_timeline_v` references columns in
> six module-owned tables, bypassing the TS barrels. A `check-f9-schema` CI guard MUST
> assert the view exists + is `security_invoker`, and a per-source integration test MUST
> fail loudly if any source column the view depends on is renamed/dropped.

> **Process**: apply each migration to live Neon (`pnpm drizzle-kit migrate`) **and run
> `pnpm test:integration` before committing** code that references new enums/columns
> (CLAUDE.md R8 gotcha). The cross-tenant isolation integration test (Principle I) is
> authored against these migrations.
