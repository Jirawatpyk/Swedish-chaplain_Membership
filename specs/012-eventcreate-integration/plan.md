# Implementation Plan: F6 — EventCreate Integration

**Branch**: `012-eventcreate-integration` | **Date**: 2026-05-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/012-eventcreate-integration/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0**
**Predecessors**: F1 Auth & RBAC (PR #1), F2 Membership Plans (`002-membership-plans`), F3 Members & Contacts (`005-members-contacts`), F4 Invoices & Receipts (`007-invoices-receipts`, PR #12), F5 Online Payment (`009-online-payment`, PR #16), F7 Email Broadcast (`010-email-broadcast`, PR #23), F8 Renewal Tracking + Smart Reminders (`011-renewal-reminders`, PR #24)
**Hook providers**: F8 `EventAttendeesPort` (stub-returns `[]` while F6 is dark) — F6 ships a concrete `DrizzleEventAttendeesAdapter` and flips F8's port to its real implementation at F6 production cut-over. No code change to F8 is required; only adapter wiring in the F8 composition root.
**Production gate**: F6 ships **dark behind `FEATURE_F6_EVENTCREATE` (default `false`)**. Flag flips per tenant after the operator has (a) completed the Zapier setup wizard against a staging webhook URL, (b) successfully invoked the "Test webhook" round-trip, and (c) the maintainer has co-signed the security checklist. No platform-wide MVP-cutover dependency: F6 can be enabled per tenant at any point post-merge.

## Summary

F6 closes the chamber's single biggest manual data-handling loop: today the admin runs an EventCreate event, exports attendees to Excel after the fact, and copy-pastes the data into internal records — losing fidelity, dropping member-benefit accounting, and burning ~15 minutes per event in error-prone bookkeeping. F6 replaces that loop with an **automated, member-centric import** via a per-tenant signed webhook fed by a Zapier Zap that watches EventCreate's "New Attendees Registered" and "New Purchase Complete" triggers. The handler verifies an HMAC-SHA256 + timestamp + idempotency-key envelope, resolves the attendee against the tenant's member directory (contact-email → domain → fuzzy company name → non-member), upserts the event row, inserts the registration row, decrements the matching member's partnership-per-event or cultural-annual quota when the event qualifies, and emits one audit log entry. An admin events list + event detail page surfaces match rates and quota effects in real time; a CSV import path covers historical backfill and Zapier outages; a tenant onboarding wizard provides one-time webhook secret reveal + Zapier walkthrough + round-trip test button.

F6 carries **⚠ PII** sensitivity (attendee names + emails + companies — including non-member attendees with weaker lawful basis) and **⚠ External-integration** scope (third-party SaaS via Zapier middleware). Principle IV (PCI DSS) is **N/A** — F6 has zero payment surface; ticket prices arrive as already-paid amounts from EventCreate (record-only). Review gate requires **≥2 reviewers** under the default rule, or the Constitution § IX.5-stack solo-maintainer substitute when no second human reviewer is available (per F1+F4+F5+F7+F8 precedent).

**Scope confirmed from spec** (7 clarifications resolved across 2 sessions of `/speckit.clarify` — Session 2026-05-12 round 1 Q1–Q5 + round 2 Q1–Q2; full provenance in spec.md `## Clarifications`): 7 user stories (US1–US7; US1+US2+US3 all **P1**), **40 functional requirements** (FR-001…FR-037 + amendments FR-011a permissive payload validation + FR-019a admin-archive lifecycle + FR-032a PDPA/GDPR erasure tool; FR-035 RBAC matrix; FR-036 observability surface; FR-037 strict-transactional handler), **12 success criteria** (SC-001…SC-012), **~35 named audit event types** (full taxonomy in `data-model.md` § 4), **4 new DB tables** (events, event_registrations, tenant_webhook_configs, eventcreate_idempotency_receipts — F6-owned, NOT F5 reuse) + **2 forward-compat JSONB columns** + **~8 migrations** (0127–0134 — next available block after F8 PR #24's 0126), **1 new bounded context** `src/modules/events/`, **0 new npm dependencies** (F6 reuses F1's `@node-rs/argon2`-free crypto via Node's built-in `crypto.timingSafeEqual` + F1's existing pino + OTel + zod stack; CSV parsing uses the standard library + a lightweight pure-TS streaming reader — no `csv-parse` external dep). Forward-compat seam: `events.metadata` JSONB + `event_registrations.metadata` JSONB preserve unknown payload fields (FR-011a) so EventCreate field additions never break ingest.

**Technical approach**: Reuse the F1+F2+F3+F4+F5+F7+F8 stack unchanged — Next.js 16 App Router + React 19 + TypeScript 5.7 strict + Drizzle ORM on Neon Postgres + Postgres RLS via `runInTenant(ctx, fn)` + shadcn/ui + Tailwind v4 + next-intl + Vitest + Playwright + pino + @vercel/otel. Add **one new bounded context** `src/modules/events/` housing `EventAggregate` + `EventRegistration` + `TenantWebhookConfig` + `WebhookReceipt` + `MatchResolution` + `QuotaEffect` types, with ports `WebhookSignatureVerifier`, `IdempotencyStore`, `AttendeeMatcher`, `QuotaAccountingPort`, `CsvImporter`, `WebhookEventAuditEmitter` (the Zapier-fed inbound surface is a Vercel route handler `/api/webhooks/eventcreate/v1/[tenantSlug]/route.ts`, NOT a port — F6 is the **consumer** of the inbound HTTP request, not an outbound caller). Add **two new API route families**: `/api/webhooks/eventcreate/v1/[tenantSlug]` (public-but-HMAC-authenticated webhook receiver pinned to Node.js runtime — needs raw body for HMAC verify + transactional DB) + `/api/admin/events/*` (admin events list / detail / relink / override / archive / erasure / CSV import / integration config + secret rotation + test webhook). **Two cron handlers** (both Node runtime, both Bearer-auth via `CRON_SECRET`, both daily, both follow the multi-tenant iteration pattern per research.md R9): (1) `/api/internal/retention/pseudonymise-eventcreate` — non-member PII pseudonymisation sweep at the 2-year retention threshold (FR-032 / SC-011); (2) `/api/internal/retention/sweep-eventcreate-idempotency` — TTL cleanup of `eventcreate_idempotency_receipts` rows past `ttl_expires_at` (7-day TTL per data-model § 1.4, keeps the table bounded at ~200 rows in flight). Admin UI is a dedicated `/admin/events` + `/admin/events/[eventId]` + `/admin/events/import` + `/admin/integrations/eventcreate` route tree (TanStack Table v8 — reuse the F3 directory + F4 invoice-list + F7 broadcast-queue pattern). F6 extends F4's barrel with nothing (no F4 dependency), but populates F8's `EventAttendeesPort` with the real adapter at composition-root wiring (F8 stub-port pattern unchanged). Enterprise UX per `docs/ux-standards.md`; WCAG 2.1 AA on every surface; SV+EN+TH at release; differentiated retention (member-linked 5y, non-member 2y then pseudonymise — FR-032) implemented via a daily cron + audit trail.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3+F4+F5+F7+F8

**Runtime**: Node.js 22 LTS (Vercel Fluid Compute) — unchanged. **Webhook receiver + CSV import handler + retention-sweep cron all pinned to Node.js runtime** (NOT Edge) for raw-body access (HMAC signature verify needs the unparsed body bytes), Drizzle pool access, and `crypto.timingSafeEqual` from the Node `crypto` standard library. Mirrors the F4/F5/F7/F8 cron handler runtime constraint.

**Framework**: Next.js 16 App Router + Cache Components + Turbopack — unchanged

**Primary Dependencies**:

- **from F1+F2+F3+F4+F5+F7+F8** (unchanged versions): `next@^16`, `react@^19`, `drizzle-orm` + `drizzle-kit`, `next-intl`, `zod`, `react-hook-form` + `@hookform/resolvers/zod`, `shadcn/ui` + `tailwindcss@^4` + `lucide-react`, `next-themes`, `sonner`, `cmdk` (F6 extends palette with "Events", "Integration: EventCreate", "Send test webhook", "Import CSV"), `@tanstack/react-table@^8` (F6 reuses F3/F4/F7/F8 pattern for admin events list + attendee table), `@vercel/otel` + `@opentelemetry/api`, `pino`, `vitest`, `playwright`, `@axe-core/playwright`, `@upstash/ratelimit` + `@upstash/redis` (for FR-005 60 req/min/tenant webhook rate limit + per-source-IP token-bucket on portal endpoints).
- **new in F6**: **NONE**. Deliberate design constraint per Constitution Principle X (Simplicity) and the F8 precedent (F8 added zero deps for renewals). HMAC + idempotency + CSV parsing all delivered with the Node standard library and project-internal utilities.
- **rejected** (YAGNI / constitutional / scope-creep guard):
  - **`csv-parse` / `papaparse` / `fast-csv`** — rejected because the F6 CSV format is small (~7 columns), the parsing requirement is one-shot per import (no streaming-during-network case), and a 60-line internal `parseCsvFile()` helper covers the v1 contract. Adds maintenance burden + supply-chain surface for negligible upside.
  - **`bullmq` / `agenda` / `inngest` for CSV import job queue** — rejected because the 1k-row import target (SC-006: 1000 rows in <60s) fits within a single Fluid Compute function timeout (300s default in 2026). Cron handler + inline processing is sufficient; we can re-evaluate at the >10k-row use case if/when it arrives.
  - **EventCreate native SDK** — rejected because **EventCreate has no public REST/GraphQL API** (research consolidated in `docs/event-integration-analysis.md` § 2). Zapier is the only programmatic surface, and Zapier produces a generic HTTP POST that does not need an SDK.
  - **Fuzzy-match library (`fuse.js`, `string-similarity`, etc.)** — rejected for v1 because a hand-rolled normalisation + Levenshtein function with a small (tens-of-lines) loop over `members.normalised_company_name` is sufficient at SweCham scale (~131 members; design envelope <2,000 members). If a future tenant pushes member count >2k AND match rate drops, we can introduce a real fuzzy library; YAGNI until then.
  - **Native EventCreate webhook integration (bypass Zapier)** — rejected by research: EventCreate does not offer native developer webhooks. The Zapier dependency is unavoidable.
  - **Auto-promote on-tenant Excel re-keying ingestion to "live mirror"** — out of MVP; F6's read-only-after-import model is explicit and matches `docs/event-integration-analysis.md` § 12 (Out of Scope).

**Storage**:

- Primary: PostgreSQL via Neon `ap-southeast-1` Singapore — unchanged. Adds **four new tables**: `events`, `event_registrations`, `tenant_webhook_configs`, `eventcreate_idempotency_receipts`. Extensions to `audit_log` (~35 new event types only — reuses `payload jsonb` (F2 migration 0007) + `tenant_id` (F2 migration 0007) + `retention_years` (F5 migration 0038) columns; F6's audit emitter writes structured payload to `payload jsonb`, NOT to the legacy `summary` TEXT column). `eventcreate_idempotency_receipts` is F6-owned (see data-model § 1.4) — F5's `processor_events` is Stripe-specific and not reusable; per Constitution Principle III bounded-context discipline, F6 introduces its own idempotency table + 7-day TTL sweep cron rather than overload F5's processor-events surface.
- Postgres RLS: every F6-introduced table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy, identical to F2/F3/F4/F5/F7/F8 pattern. `runInTenant(ctx, fn)` reused unchanged. `DEBUG_RLS_STATE=1` dev-mode safety net inherited. **Exception**: The webhook receiver `/api/webhooks/eventcreate/v1/[tenantSlug]` runs an unauthenticated public entry under a narrow bypass context — the request bears no user session; tenant is resolved from the URL path AND cross-checked against the tenant whose secret verified the HMAC; immediately after signature verification the tx binds `app.current_tenant` via `runInTenant` for the entire ACID unit (FR-037). Mirrors F5's webhook + F7's unsubscribe + F8's renewal-link-token pre-tenant bypass pattern.
- Indexes (all `CREATE INDEX CONCURRENTLY` outside migration tx — same F4/F5/F7/F8 pattern):
  - `events(tenant_id, source, external_id) UNIQUE` — webhook upsert key (FR-010)
  - `events(tenant_id, start_date DESC) WHERE archived_at IS NULL` — partial index for events list default view (FR-020)
  - `events(tenant_id, is_partner_benefit) WHERE archived_at IS NULL` — admin filter on benefit flag
  - `events(tenant_id, is_cultural_event) WHERE archived_at IS NULL` — admin filter on cultural flag
  - `event_registrations(tenant_id, event_id, external_id) UNIQUE` — attendee replay idempotency (FR-011)
  - `event_registrations(tenant_id, event_id, registered_at DESC)` — attendee table render (FR-021)
  - `event_registrations(tenant_id, matched_member_id) WHERE matched_member_id IS NOT NULL` — F8 `EventAttendeesPort` lookup by member
  - `event_registrations(tenant_id, attendee_email_lower)` — admin attendee-by-email erasure search (FR-032a)
  - `event_registrations(tenant_id, match_type) WHERE match_type IN ('unmatched','non_member')` — admin "needs relink" filter
  - `event_registrations(tenant_id, registered_at) WHERE match_type IN ('non_member','unmatched') AND pii_pseudonymised_at IS NULL` — partial index for the daily retention-sweep cron (FR-032)
  - `tenant_webhook_configs(tenant_id, source) PRIMARY KEY` — one row per (tenant, source)
- **No new Blob storage** — F6 has no document/PDF surface. CSV uploads are streamed in-memory through the import handler and discarded after persistence.
- Session / rate-limit cache: Upstash Redis (Singapore) — unchanged. F6 adds **four new token buckets**:
  - `POST /api/webhooks/eventcreate/v1/[tenantSlug]` — **60 req/min per `tenant_id`** (FR-005; reject excess with 429 + `Retry-After`)
  - `POST /api/admin/events/import` — **5 imports / 1h per `(tenant_id, actor_user_id)`** (prevent runaway uploads)
  - `POST /api/admin/integrations/eventcreate/rotate-secret` — **3 rotations / 1h per `(tenant_id, actor_user_id)`** (guard against accidental hammer)
  - `POST /api/admin/integrations/eventcreate/test-webhook` — **10 tests / 1h per `(tenant_id, actor_user_id)`** (test-button anti-spam)

**Testing**:

- `vitest` — unit + Application tests. Coverage thresholds: Domain 100% line; Application ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases**:
  - `verify-webhook-signature.ts` (every FR-002 + FR-003 path: valid / wrong-secret / timestamp-skew / replayed-grace-key / deprecated-after-24h / tampered-body — all paths return identical generic error to avoid signature oracle)
  - `ingest-webhook-attendee.ts` (FR-010 + FR-011 + FR-011a + FR-037 — strict transactional path: event upsert + registration insert + idempotency receipt + quota decrement all in one tx; rollback on any failure; failed-delivery audit emitted in separate post-rollback tx)
  - `match-attendee-to-member.ts` (FR-012 — 4-rule ordering: contact-email → domain → fuzzy → non_member; personal-email deny list; ambiguous-fuzzy → unmatched; per-tenant scope)
  - `apply-quota-effect.ts` (FR-015 + FR-016 + FR-017 + FR-018 — partnership-per-event decrement; cultural-annual decrement; exhausted → counted=false; refund credit-back)
  - `relink-registration.ts` (FR-014 — credit-back old member quota + re-evaluate new member quota; admin-only; audit-logged with actor)
  - `archive-event.ts` (FR-019a — admin-only; reverses all quota flags for the event's registrations; archives row; audit each reversal)
  - `enforce-rbac-on-f6-mutation.ts` (FR-035 — every mutating use-case rejects `manager` role at the application layer with 403 + `role_violation_blocked` audit; `member` role rejected on admin endpoints with 404 to avoid surface disclosure)
  - `enforce-tenant-context-on-event.ts` (cross-tenant probe refusal on every read/write + `cross_tenant_probe` audit; URL-path tenant ≠ secret-resolved tenant → 401 + audit)
  - `import-csv.ts` (FR-026 + FR-027 + FR-028 + FR-029 — column-mapping inference; valid + invalid rows; result summary; same match logic as webhook)
  - `erase-attendee-pii.ts` (FR-032a — deletes PII + cascade to registration rows + reverse quota + audit; idempotent on re-run)
  - `pseudonymise-stale-non-member-pii.ts` (FR-032 — daily sweep; deterministic per-tenant salt; quota fields preserved; matched-link metadata preserved; audit logged per row)
- `playwright` — E2E with existing F1+F2+F3+F4+F5+F7+F8 setup. New specs:
  - `tests/e2e/eventcreate-webhook-ingest.spec.ts` (US1 AS1–AS5 — happy verify+match+200; non-member persistence; duplicate 409; bad signature 401; timestamp-skew 401)
  - `tests/e2e/events-list-and-detail.spec.ts` (US2 AS1–AS3 — paginated list with match-rate; attendee table with quota effect; deep link back to EventCreate)
  - `tests/e2e/integration-config-wizard.spec.ts` (US3 AS1–AS3 — one-time secret reveal + Zapier walkthrough + test-webhook button + recent-deliveries panel)
  - `tests/e2e/quota-accounting.spec.ts` (US4 AS1–AS4 — partnership-6 decrement; over-quota 7th; cultural annual; refund credit-back)
  - `tests/e2e/csv-fallback-import.spec.ts` (US5 AS1–AS3 — preview + 1k-row import + error report)
  - `tests/e2e/relink-attendee.spec.ts` (US6 AS1–AS2 — non-member → member; quota recompute on relink)
  - `tests/e2e/secret-rotation.spec.ts` (US7 AS1–AS3 — rotate + grace + expiry)
  - `tests/e2e/eventcreate-a11y.spec.ts` (axe-core on events list / detail / integration config / CSV import / wizard)
  - `tests/e2e/eventcreate-i18n.spec.ts` (TH + EN + SV coverage on every F6 surface)
  - `tests/e2e/manager-readonly-events.spec.ts` (FR-035 — manager sees events list + detail; mutating CTAs absent; direct API POST returns 403)
- `@axe-core/playwright` — WCAG 2.1 AA on every new screen (events list / event detail / integration config / CSV import / archive confirm dialog).
- **New cross-tenant integration test for F6** (Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker): `tests/integration/events/tenant-isolation.test.ts` — creates two tenants, seeds events + registrations + webhook configs + idempotency receipts for each, asserts zero cross-tenant visibility on SELECT/INSERT/UPDATE/DELETE across **all 4 F6 tables** (`events`, `event_registrations`, `tenant_webhook_configs`, `eventcreate_idempotency_receipts`), plus emission of `cross_tenant_probe` on every probe attempt from both directions. Also asserts that the new `eventcreate_idempotency_receipts` RLS+FORCE policy correctly rejects cross-tenant SELECT/INSERT attempts (an attacker who knows a foreign tenant's `request_id` cannot probe the table). Plus a separate cross-tenant probe via the webhook URL (a payload signed for tenant A POSTed to tenant B's URL → reject + audit).
- **New strict-transactional integration test** (FR-037): `tests/integration/events/transactional-ingest.test.ts` — simulate failure at every stage of the ACID unit (event-upsert error, registration-insert error, idempotency-receipt error, quota-decrement error) → assert (a) zero side effects persisted, (b) failed-delivery audit emitted in separate tx, (c) Zapier replay after recovery commits cleanly without double-side-effect.
- **New idempotency integration test** (FR-004): `tests/integration/events/idempotency.test.ts` — same `X-Request-ID` delivered 5× → asserts 1 event row + 1 registration row + 1 quota decrement + 1 audit `webhook_receipt_verified` + 4 audit `webhook_duplicate_rejected`.
- **New signature-verification integration test** (FR-002): `tests/integration/events/signature.test.ts` — valid signature + grace-key signature within 24h + grace-key signature at 25h + wrong secret + tampered body + missing header → all paths return identical 401 generic body (no oracle); audit emits correct outcome per case.
- **New CSV-equivalence integration test** (FR-027): `tests/integration/events/csv-webhook-equivalence.test.ts` — same 100 attendees delivered via webhook vs. CSV → assert event + registration rows are byte-equivalent on all match/quota fields.
- **New retention-sweep integration test** (FR-032 + SC-011): `tests/integration/events/retention-sweep.test.ts` — seed 1k non-member registrations at varying ages, run daily sweep cron, assert (a) rows past 2y threshold pseudonymised, (b) member-linked rows untouched, (c) `pii_pseudonymised` audit emitted per row, (d) quota and match metadata preserved.
- **New idempotency-TTL-sweep integration test** (Z5 cron / AA1 metric): `tests/integration/events/idempotency-ttl-sweep.test.ts` — seed `eventcreate_idempotency_receipts` rows with mixed `ttl_expires_at` (past + future) across two tenants; run the daily `/api/internal/retention/sweep-eventcreate-idempotency` cron; assert (a) all rows with `ttl_expires_at < NOW()` are deleted, (b) all future-expiry rows are preserved, (c) the `eventcreate_idempotency_sweep_rows_total` OTel metric increments by the correct per-tenant count (matches deleted row count), (d) tenant A's expired rows being swept does NOT affect tenant B's table (cross-tenant isolation), (e) the cron emits a structured pino log with sweep duration + tenants-scanned count for the AA1 stalled-sweep alert to consume.
- **New PII-erasure integration test** (FR-032a + SC-012): `tests/integration/events/pii-erasure.test.ts` — admin invokes erasure on a registration with counted quota → assert PII deleted, quota credited back, audit `pii_erasure_completed`, member-linked aggregate stats unaffected.
- **New DB-unavailable chaos test** (FR-037 / E14): `tests/integration/events/db-unavailable-during-tx.test.ts` — uses a test fixture that closes the DB connection mid-tx (at each of the 4 stages: event_upsert, registration_insert, idempotency_receipt, quota_decrement); asserts (a) HTTP 5xx returned to caller, (b) zero side effects persisted to any table, (c) `webhook_rolled_back` audit reaches stderr via `pino.fatal` (per E3 dual-write fallback) when the secondary audit-tx also fails, (d) Zapier-replay-after-DB-recovery commits cleanly without double-side-effect (the idempotency receipt is gone with the rollback, so the retry is correctly recognised as fresh).
- **New F8-port-wired-correctly integration test** (X3): `tests/integration/events/f8-port-wiring.test.ts` — sets `FEATURE_F6_EVENTCREATE=true`, calls F8's `computeAtRiskScore` use-case for a member with seeded event attendance, asserts the at-risk score reflects real attendance counts (NOT the stub's `[]` empty result); sets `FEATURE_F6_EVENTCREATE=false` and asserts F8 falls back to stub. Catches the silent-failure mode where F6 deploys but the composition root forgets to swap the adapter.
- **New quota-concurrency property-based test** (SC-004 / E11): `tests/integration/events/quota-concurrency.test.ts` using `fast-check@^4` (existing F4/F8 devDep) — spawns N=10 concurrent ingest workers against the same `(tenant, member, partner-benefit-event)` with a 6-ticket allotment, asserts `SUM(counted_against_partnership) ≤ 6` across 100 random worker schedules. Covers the advisory-lock effectiveness for SC-004's 0-error commitment.
- **Phase 10 perf benchmarks** (E5 + E12): two additional benches alongside existing list-render + cron-pass benches —
  - `bench/events/csv-import-memory.ts` (E5): profile peak heap during 1k + 5k row CSV imports; assert peak <500 MiB (well under Vercel Fluid Compute's 1 GB default); fail-fast if exceeded.
  - `bench/events/attendee-fuzzy-match.ts` (E12): measure `match-attendee-to-member.ts` p95 latency at 5,000-member fixture; assert <50ms per ingest. If fail at 5k, fallback strategy is Postgres `pg_trgm` GIN index lookup OR pre-computed normalised-name table (decision deferred to bench results).

**Target Platform**: Modern evergreen browsers (Chrome / Edge / Firefox / Safari latest 2 + Mobile Safari iOS 16+ + Chrome for Android 12+). Server: Vercel Fluid Compute Singapore region. Database: Neon Postgres `ap-southeast-1` Singapore.

**Project Type**: Web application (Next.js App Router fullstack — admin portal + public webhook receiver + retention-sweep cron), reusing the F1–F8 monorepo structure. Single project; no separate `frontend/`+`backend/` split.

**Performance Goals** (per spec FR-005, SC-003, SC-006, SC-011, plus Scale envelope assumption):

- Webhook ingest: **p95 < 300ms** (FR-005 + SC-003) measured against the medium-chamber scale envelope (~50,000 registrations/yr/tenant, sustained 60 req/min burst)
- Events list `/admin/events`: **p95 render < 500ms** at 100 events × 500 attendees (medium-chamber scale envelope per Q1.2)
- Event detail `/admin/events/[eventId]`: **p95 render < 600ms** at 500 attendees per event
- CSV import: **1,000 rows in <60s** (SC-006) inline (no background-job dependency)
- Retention-sweep cron: **full pass <60s** for a tenant with 50,000 registrations
- Secret rotation + test-webhook round-trip: **<2s** total

**Constraints**:

- **Multi-tenant isolation** (Constitution v1.4.0 Principle I, NON-NEGOTIABLE) — every F6 table carries `tenant_id` + RLS+FORCE; cross-tenant integration test is a Review-Gate blocker
- **Test-first** (Constitution Principle II, NON-NEGOTIABLE) — every user story has ≥1 failing acceptance test before implementation; security-critical use-cases at 100% branch coverage
- **Clean Architecture** (Constitution Principle III, NON-NEGOTIABLE) — `src/modules/events/` ships with public barrel + ESLint `no-restricted-imports` boundary rule
- **PCI DSS** (Constitution Principle IV, NON-NEGOTIABLE) — N/A: F6 has zero payment surface; F5 unchanged; ticket prices arrive as already-paid amounts from EventCreate (record-only)
- **i18n** (Constitution Principle V) — EN+TH+SV at release; estimated ~150 new keys × 3 locales = 450 entries
- **Inclusive UX / WCAG 2.1 AA** (Constitution Principle VI) — keyboard-first events list, screen-reader landmarks on event detail, no colour-only signalling on match-status badges
- **Performance & Observability** (Constitution Principle VII) — FR-036 commits ~11 OTel metrics + ~6 alerts + 3 runbooks wired before /speckit.verify (round-4 AA1 added the idempotency-sweep-rows counter + idempotency-sweep-stalled alert)
- **Reliability** (Constitution Principle VIII) — every webhook delivery transactional per FR-037; idempotency on `X-Request-ID` + per-attendee `externalId`; every mutating action audited; secret rotation has 24h grace
- **Code Quality** (Constitution Principle IX) — TypeScript strict, ESLint clean, Conventional Commits, solo-maintainer substitute applies (per F1+F4+F5+F7+F8 precedent — see Complexity Tracking entry #1)
- **Simplicity** (Constitution Principle X) — zero new npm dependencies; no native EventCreate SDK; no separate idempotency-store infrastructure (reuses F5's table); no background-job queue for CSV (inline)

**Scale/Scope**: Per-tenant up to **100 events/yr × 500 attendees/event = 50,000 registrations/yr** (medium-chamber envelope per spec Q1.2). Current SweCham scale: ≤30 events/yr × ≤200 attendees = ~6,000 registrations/yr — F6 sits at ~5× headroom over today. Webhook burst: sustained 60 req/min/tenant (FR-005). CSV imports: design target 1k rows per upload; >10k rows pushed to F6.1 backlog.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.4.0*

**NON-NEGOTIABLE gates** (any FAIL blocks the plan; no waivers):

- [X] **I. Data Privacy & Security** — F6 processes PII (attendee name + email + company; for both member-linked and non-member attendees). Lawful basis is **legitimate interest** under PDPA §24(5) and GDPR Art. 6(1)(f) — chamber's record of who attended its events; documented in spec.md Assumptions § Privacy + compliance posture. Differentiated retention per FR-032 (member-linked 5y, non-member 2y then pseudonymise). Erasure tool per FR-032a satisfies PDPA §30 / GDPR Art. 17 within 30 days (SC-012). RBAC checks on every protected route per FR-035 (admin / manager / member). OWASP Top 10 mitigations: A01 (broken access control) — RBAC matrix in FR-035; A02 (cryptographic failures) — TLS 1.2+ inherited from Vercel + at-rest AES-256 inherited from Neon + HMAC-SHA256 webhook auth with per-tenant secret + timing-safe compare per FR-002; A03 (injection) — Drizzle parameterised queries + zod-validated boundaries; A05 (security misconfiguration) — Postgres RLS+FORCE on every F6 table; A07 (auth failures) — F1 session model unchanged + per-tenant HMAC + 5-min timestamp skew + idempotency replay protection. Multi-tenant isolation: **4 new tables** (`events`, `event_registrations`, `tenant_webhook_configs`, `eventcreate_idempotency_receipts` — round-2 M2 introduced the 4th) all carry `tenant_id` + RLS+FORCE policies; mandatory cross-tenant integration test (Review-Gate blocker — `tests/integration/events/tenant-isolation.test.ts`) covers all 4 tables (round-3 Z4); cross-tenant access logged as high-severity (`cross_tenant_probe`); F1 `users` exception unchanged.

- [X] **II. Test-First Development** — Each user story (US1–US7) has ≥1 acceptance test planned in `tasks.md` ahead of implementation. Coverage targets: Domain 100% line, Application 80% line+branch overall, **100% branch on security-critical use cases** (`verify-webhook-signature`, `ingest-webhook-attendee`, `enforce-rbac-on-f6-mutation`, `enforce-tenant-context-on-event`, `erase-attendee-pii`, `relink-registration`, `archive-event`). Integration tests against live Neon (no mocked DB) for every state-machine transition + every cron pass + every webhook outcome category.

- [X] **III. Clean Architecture** — One new bounded context `src/modules/events/` with `domain/` + `application/` + `infrastructure/` + public barrel `index.ts`. Domain layer carries `EventAggregate`, `EventRegistration`, `TenantWebhookConfig`, `WebhookReceipt`, `MatchResolution`, `QuotaEffect`, `AttendeeRecord` value objects with no `next` / `drizzle-orm` / `resend` / `react` imports — enforced by ESLint `no-restricted-imports` rule scoped to `src/modules/events/domain/**`. Application layer orchestrates Domain via ports (`WebhookSignatureVerifier`, `IdempotencyStore`, `AttendeeMatcher`, `QuotaAccountingPort`, `CsvImporter`, `WebhookEventAuditEmitter`, `RetentionSweeper`); Drizzle types live in Infrastructure only. Public barrel exports use-cases (`ingestWebhookAttendee`, `archiveEvent`, `relinkRegistration`, `togglePartnerBenefit`, `toggleCulturalEvent`, `eraseAttendeePii`, `importCsv`, `rotateWebhookSecret`, `runTestWebhook`, `pseudonymiseStaleNonMemberPii`) + types + (for F8 adapter) `getEventAttendeesByMember` — no deep imports allowed from outside the module.

- [X] **IV. Payment Security (PCI DSS)** — **N/A**. F6 has zero payment surface. Ticket prices arrive on the webhook payload as already-settled amounts in THB (record-only); F6 does not initiate, capture, refund, or tokenize any payment. F5's SAQ-A scope is unaffected by F6.

**Core principle gates** (FAIL must be justified in Complexity Tracking):

- [X] **V. Internationalization (SV/EN/TH)** — All F6 user-facing strings use i18n keys. EN canonical + TH + SV all ship at release per FR-030. Missing EN fails build; missing TH/SV falls back to EN with CI warning that becomes blocking on release branches. No Thai Buddhist Era display rule applies (F6 has no tax-document surface; event dates display per platform convention). Estimated new i18n keys: ~150 across 3 locales = 450 entries (events list labels + event detail attendee table + integration config wizard + CSV import flow + 6 reusable status badges + 35 audit event descriptions + Zapier walkthrough copy).

- [X] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — All admin surfaces designed mobile-first 320px+. WCAG 2.1 AA verified per FR-031 via axe-core E2E. Reuses shadcn/ui primitives + Tailwind v4 design tokens established in `004-page-layout-standard` + `006-layout-container-tier2`. Events list uses TanStack Table v8 with full keyboard navigation (proven in F3/F4/F7/F8). Status badges + quota-effect indicators use shape + text + colour (never colour alone) so colour-blind users have full information parity.

- [X] **VII. Performance & Observability** — Performance budgets stated in FR-005, FR-031 (implicit via SC-003), SC-006. Observability per FR-036 (**~11 OTel metrics + ~6 alerts + 3 runbooks** — round-4 AA1 added the idempotency-sweep-rows counter + idempotency-sweep-stalled alert; matches F7/F8 ship-readiness bar; conforms to `docs/observability.md` § 14). pino structured logs with forbidden-fields redact list extended for F6 secrets (webhook_secret, X-Chamber-Signature header value, attendee email when masking is required by audit replay). All cron jobs (retention sweep + idempotency TTL sweep) emit per-pass duration + row-count metrics for SLO tracking. Webhook handler emits p50 + p95 latency histogram.

- [X] **VIII. Reliability** — Every error path explicitly handled. FR-037 enshrines strict-transactional webhook handling: event upsert + registration insert + idempotency receipt + quota decrement all commit in ONE database transaction; any error rolls back fully and returns HTTP 5xx so Zapier retries via backoff. Failed-delivery audit emitted in separate post-rollback transaction (observability preserved). Idempotency on `X-Request-ID` (FR-004) + per-attendee `externalId` (FR-011) gives two independent dedup layers. Audit trail of ~35 events with retention 5 years for the audit-log entries themselves regardless of differentiated attendee PII retention path.

- [X] **IX. Code Quality Standards** — TypeScript strict, ESLint clean, Conventional Commits, solo-maintainer substitute applies (per F1+F4+F5+F7+F8 precedent — see Complexity Tracking entry #1).

- [X] **X. Simplicity (YAGNI)** — Zero new npm dependencies. Hand-rolled HMAC verify + CSV parser + Levenshtein fuzzy match are all <100-line internal helpers, individually unit-tested at 100% line coverage. No background-job queue (CSV inline). No native EventCreate SDK (Zapier is the only available surface). All deferrals captured in spec.md § Out of scope (5 items) + plan.md "rejected" list above.

**Result**: All 10 principles **PASS**. Standing Complexity Tracking entries: #1 (solo-maintainer substitute — IX.5-stack), #2 (F6-owned idempotency table — no cross-module reuse; revised round-2 M2).

## Project Structure

### Documentation (this feature)

```text
specs/012-eventcreate-integration/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── webhook-eventcreate-api.md
│   ├── admin-events-api.md
│   ├── admin-integration-eventcreate-api.md
│   ├── csv-import-api.md
│   └── audit-port.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit.specify already created)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   └── events/                                # F6 bounded context (NEW)
│       ├── index.ts                           # Public barrel (Constitution Principle III)
│       ├── domain/                            # Pure types — zero framework imports
│       │   ├── event.ts                       # Event aggregate (incl. archived_at lifecycle)
│       │   ├── event.spec.ts
│       │   ├── event-registration.ts          # Registration aggregate + match_type + quota flags
│       │   ├── event-registration.spec.ts
│       │   ├── tenant-webhook-config.ts       # Active + grace secret model + rotation invariants
│       │   ├── webhook-receipt.ts             # Idempotency key + signature outcome value-object
│       │   ├── match-resolution.ts            # 4-rule matcher result + ambiguity model
│       │   ├── quota-effect.ts                # Partnership vs. cultural decrement decision model
│       │   ├── attendee-record.ts             # Inbound attendee value-object (payload + CSV)
│       │   ├── eventcreate-payload.ts         # Zod schema for v1 contract (strict-required, permissive-unknown)
│       │   ├── normalise-company-name.ts      # Pure normalisation for fuzzy match
│       │   ├── levenshtein.ts                 # Pure distance function
│       │   ├── personal-email-deny-list.ts    # Static deny list + tenant-extensible
│       │   └── value-objects/
│       │       ├── match-type.ts              # 'member_contact' | 'member_domain' | 'member_fuzzy' | 'non_member' | 'unmatched'
│       │       ├── payment-status.ts          # 'paid' | 'pending' | 'refunded' | 'free'
│       │       ├── source.ts                  # 'eventcreate' (extensible)
│       │       └── webhook-outcome.ts         # 8 outcome states for audit
│       ├── application/                       # Use-cases — orchestrate Domain via ports
│       │   ├── ports/
│       │   │   ├── webhook-signature-verifier.ts
│       │   │   ├── idempotency-store.ts
│       │   │   ├── attendee-matcher.ts
│       │   │   ├── quota-accounting-port.ts
│       │   │   ├── events-repository.ts
│       │   │   ├── registrations-repository.ts
│       │   │   ├── tenant-webhook-config-repository.ts
│       │   │   ├── audit-port.ts              # ~35 F6 audit event types
│       │   │   ├── csv-importer.ts
│       │   │   └── retention-sweeper.ts
│       │   ├── ingest-webhook-attendee.ts     # Strict-transactional (FR-037)
│       │   ├── ingest-webhook-attendee.spec.ts
│       │   ├── verify-webhook-signature.ts    # FR-002, FR-003, FR-008
│       │   ├── verify-webhook-signature.spec.ts
│       │   ├── match-attendee-to-member.ts    # FR-012
│       │   ├── apply-quota-effect.ts          # FR-015, FR-016, FR-017, FR-018
│       │   ├── relink-registration.ts         # FR-014
│       │   ├── archive-event.ts               # FR-019a
│       │   ├── toggle-event-category.ts       # FR-019 (is_partner_benefit / is_cultural_event)
│       │   ├── erase-attendee-pii.ts          # FR-032a
│       │   ├── pseudonymise-stale-non-member-pii.ts  # FR-032 retention sweep
│       │   ├── import-csv.ts                  # FR-026, FR-027, FR-028, FR-029
│       │   ├── rotate-webhook-secret.ts       # FR-008
│       │   ├── generate-webhook-secret.ts     # one-time-reveal flow (FR-024)
│       │   ├── run-test-webhook.ts            # FR-023
│       │   ├── list-events.ts                 # FR-020
│       │   ├── load-event-detail.ts           # FR-021
│       │   ├── list-recent-deliveries.ts      # FR-022
│       │   ├── enforce-rbac-on-f6-mutation.ts # FR-035
│       │   ├── enforce-tenant-context-on-event.ts
│       │   └── get-event-attendees-by-member.ts  # F8 EventAttendeesPort impl-side
│       └── infrastructure/                    # Adapters — Drizzle, Resend, Upstash, crypto
│           ├── schema.ts                      # Drizzle schema for 3 new tables
│           ├── drizzle-events-repository.ts
│           ├── drizzle-registrations-repository.ts
│           ├── drizzle-tenant-webhook-config-repository.ts
│           ├── crypto-webhook-signature-verifier.ts  # crypto.timingSafeEqual
│           ├── drizzle-idempotency-store.ts          # Writes to F6-owned eventcreate_idempotency_receipts table
│           ├── drizzle-attendee-matcher.ts           # 4-rule SQL match
│           ├── drizzle-quota-accounting-adapter.ts   # Bridges to F2 + F3
│           ├── streaming-csv-importer.ts             # Stdlib stream + hand-rolled parse
│           ├── pino-audit-port.ts                    # ~35 F6 audit emitters
│           ├── drizzle-retention-sweeper.ts
│           └── drizzle-event-attendees-by-member.ts  # F8 port impl
├── app/
│   ├── (staff)/admin/
│   │   ├── events/
│   │   │   ├── page.tsx                       # Events list (TanStack Table)
│   │   │   ├── loading.tsx                    # Shimmer skeleton
│   │   │   ├── [eventId]/
│   │   │   │   ├── page.tsx                   # Event detail + attendee table
│   │   │   │   ├── loading.tsx
│   │   │   │   └── registrations/
│   │   │   │       └── [registrationId]/
│   │   │   │           └── erase/page.tsx     # Confirm + reason form (FR-032a)
│   │   │   ├── import/
│   │   │   │   ├── page.tsx                   # CSV upload + preview + mapping
│   │   │   │   └── loading.tsx
│   │   │   └── archived/
│   │   │       └── page.tsx                   # Archived-events view (FR-019a)
│   │   └── integrations/
│   │       └── eventcreate/
│   │           ├── page.tsx                   # Wizard + masked secret + recent-deliveries
│   │           └── loading.tsx
│   └── api/
│       ├── webhooks/eventcreate/v1/
│       │   └── [tenantSlug]/
│       │       └── route.ts                   # Node runtime; raw body; HMAC verify
│       ├── admin/events/
│       │   ├── [eventId]/
│       │   │   ├── archive/route.ts
│       │   │   ├── toggle-partner-benefit/route.ts
│       │   │   ├── toggle-cultural-event/route.ts
│       │   │   └── registrations/
│       │   │       └── [registrationId]/
│       │   │           ├── relink/route.ts
│       │   │           └── erase/route.ts
│       │   └── import/route.ts                # multipart/form-data CSV
│       ├── admin/integrations/eventcreate/
│       │   ├── generate-secret/route.ts
│       │   ├── rotate-secret/route.ts
│       │   ├── test-webhook/route.ts
│       │   └── recent-deliveries/route.ts
│       ├── internal/
│       │   ├── retention/pseudonymise-eventcreate/route.ts        # daily cron (FR-032 PII pseudonymisation)
│       │   ├── retention/sweep-eventcreate-idempotency/route.ts # daily cron (Z5 — TTL cleanup of eventcreate_idempotency_receipts)
│       │   └── metrics/eventcreate-gauges/route.ts          # 5-min gauges
├── components/
│   └── events/                                # Presentation-only (reuses shared shadcn/ui primitives)
│       ├── events-list-table.tsx
│       ├── event-detail-header.tsx
│       ├── attendee-table.tsx
│       ├── match-status-badge.tsx
│       ├── quota-effect-badge.tsx
│       ├── relink-dialog.tsx
│       ├── archive-event-dialog.tsx
│       ├── erase-pii-dialog.tsx
│       ├── csv-mapping-form.tsx
│       ├── csv-import-result.tsx
│       ├── webhook-config-wizard.tsx
│       ├── webhook-secret-reveal.tsx
│       ├── rotate-secret-dialog.tsx
│       ├── recent-deliveries-panel.tsx
│       └── test-webhook-button.tsx
├── i18n/messages/
│   ├── en.json                                # F6 keys merged
│   ├── th.json
│   └── sv.json
└── lib/
    ├── env.ts                                 # extend zod schema for FEATURE_F6_EVENTCREATE + EVENTCREATE_PII_PSEUDONYM_SALT
    └── logger.ts                              # extend forbidden-fields redact list for F6

drizzle/migrations/
├── 0127_f6_events_table.sql
├── 0128_f6_event_registrations_table.sql
├── 0129_f6_tenant_webhook_configs_table.sql
├── 0130_f6_events_indexes.sql                 # CONCURRENT
├── 0131_f6_registrations_indexes.sql          # CONCURRENT
├── 0132_f6_audit_event_types.sql              # 35 × ALTER TYPE audit_event_type ADD VALUE (F4 precedent)
├── 0133_f6_rls_force_policies.sql
└── 0134_f6_eventcreate_idempotency_receipts.sql   # F6-owned idempotency table (NOT F5 reuse)

tests/
├── unit/events/...                            # mirrors Domain structure
├── contract/events/...                        # one per route + audit port
├── integration/events/
│   ├── tenant-isolation.test.ts               # Review-Gate blocker
│   ├── transactional-ingest.test.ts
│   ├── idempotency.test.ts
│   ├── signature.test.ts
│   ├── csv-webhook-equivalence.test.ts
│   ├── retention-sweep.test.ts
│   ├── pii-erasure.test.ts
│   ├── rbac-defence-in-depth.test.ts
│   └── quota-accounting.test.ts
└── e2e/...                                    # specs enumerated in Testing § above
```

**Structure Decision**: Single Next.js App Router monorepo, identical layout to F1–F8. F6 introduces one new bounded context `src/modules/events/` with the canonical Domain/Application/Infrastructure split + public barrel + ESLint boundary rule. Admin presentation lives under `src/app/(staff)/admin/events/**` and `src/app/(staff)/admin/integrations/eventcreate/**` following the F4/F7/F8 admin-route precedent. The public webhook receiver is a single Node-runtime route handler at `src/app/api/webhooks/eventcreate/v1/[tenantSlug]/route.ts` (the `v1` segment of the path is the explicit schema-version namespace per FR-001). One cron handler `src/app/api/internal/retention/pseudonymise-eventcreate/route.ts` runs daily (cron-job.org Bearer-auth pattern, reused from F4/F5/F7/F8). Migrations land in the 0127–0134 block (next available after F8 PR #24 closed at 0126). Tests follow the F4/F5/F7/F8 split (unit / contract / integration / e2e). No new top-level directories.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

The Constitution Check above shows all 10 principles **PASS** without violations. The following entries document **standing deviations from default workflow procedures** that all multi-feature Chamber-OS work since F1 has carried (substantive constitutional precedent, not feature-specific violations):

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **#1 Solo-maintainer substitute (Principle IX)** — F6 ships under a single-maintainer workflow without a second human reviewer. The default ≥2-reviewers + no-direct-push-to-main rules are substituted by the 5-check automated stack defined in Constitution § IX.5 (`/speckit.review` ≥3 passes with decreasing severity + `/speckit.staff-review` ≥1 round; test coverage at Principle II targets; DB-level defence-in-depth; post-remediation independent re-verification; maintainer + agent co-sign on security checklist). | Defaulting to ≥2 human reviewers would block F6 from shipping at all — there is no second human reviewer in the project today. The substitute is the same stack F1, F4, F5, F7, and F8 used successfully (zero post-ship BLOCKERS across 5 features). Reverts to the default rule when a second maintainer is added. |
| **#2 F6-owned idempotency table (no cross-module reuse)** — F6 introduces its own `eventcreate_idempotency_receipts` table for `X-Request-ID` + CSV row-hash dedup rather than overloading F5's `processor_events` (which is Stripe-specific: PK = Stripe event id, columns shaped for Stripe payloads — not generalisable without significant cross-feature schema work). | An attempt to reuse F5's table was considered (round 1 critique) but the schema impedance is real: F5's `processor_events.id = stripe_event_id` cannot fit EventCreate request IDs. The F6-owned table costs one new table + one TTL sweep cron entry; the alternative (generalising F5 into a shared `webhook_idempotency_receipts`) requires touching F5 + F5's tests + F5's migration history — a much larger blast radius. The bounded-context discipline of Constitution Principle III favours per-feature idempotency tables until a 4th integration arrives to justify generalisation. |
