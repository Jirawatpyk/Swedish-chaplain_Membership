# Tasks: F6 — EventCreate Integration

**Input**: Design documents from `/specs/012-eventcreate-integration/`
**Prerequisites**: spec.md (40 FRs, 12 SCs, 7 user stories, 12 Q&A clarifications), plan.md, research.md (R1–R14), data-model.md (4 tables, 35 audit events), contracts/ (5 files), quickstart.md, 5 checklists (187 items)
**Branch**: `012-eventcreate-integration`
**Constitution**: v1.4.0 — 4 NON-NEGOTIABLE principles + 6 Core; solo-maintainer substitute applies (per F1+F4+F5+F7+F8 precedent)
**Tests**: REQUIRED per Constitution Principle II (TDD NON-NEGOTIABLE). Each user story has failing acceptance tests authored BEFORE implementation tasks for that story.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

Next.js App Router monorepo (single project) per plan.md § Project Structure. Source at `src/`, tests at `tests/`, migrations at `drizzle/migrations/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialisation, feature flag, module scaffolding, ESLint boundary rule.

- [X] T001 Add `FEATURE_F6_EVENTCREATE` (default `'false'`) + `EVENTCREATE_PII_PSEUDONYM_SALT` (≥32 bytes base64) zod entries to `src/lib/env.ts` with boot-time validation (refuse to start when flag true but salt missing).
- [X] T002 Extend pino redact-list in `src/lib/logger.ts` with F6 secret fields: `webhook_secret_active`, `webhook_secret_grace`, `X-Chamber-Signature` header value, `attendee_email` (when audit-replay-masking required), `EVENTCREATE_PII_PSEUDONYM_SALT`.
- [X] T003 [P] Create `src/modules/events/index.ts` public barrel with placeholder exports + ESLint `no-restricted-imports` rule scoped to `src/modules/events/domain/**` blocking deep imports from outside (mirrors F2/F3/F4/F5/F7/F8 pattern).
- [X] T004 [P] Create empty bounded-context directory tree per `plan.md § Project Structure` — `src/modules/events/{domain,application,infrastructure}/`, `src/modules/events/application/ports/`, `src/modules/events/domain/value-objects/`.
- [X] T005 [P] Add F6-specific i18n key namespace placeholders in `src/i18n/messages/en.json` + `th.json` + `sv.json` under top-level keys `admin.events.*` + `admin.integrations.eventcreate.*` + `audit.eventcreate.*` (~150 keys × 3 locales — populated incrementally per user-story phase).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: DB schema + RLS + audit enum extension + Domain value objects + Application ports — MUST complete before any user-story implementation.

### Database Schema + Migrations

- [X] T006 Create `drizzle/migrations/0127_f6_events_table.sql` per data-model.md § 1.1 — CREATE TABLE `events` with all columns + PK `(tenant_id, event_id)` + CHECK on `source` enum + `metadata` JSONB.
- [X] T007 Create `drizzle/migrations/0128_f6_event_registrations_table.sql` per data-model.md § 1.2 — CREATE TABLE `event_registrations` with FK `(tenant_id, event_id)` REFERENCES events + CHECK on `match_type` + CHECK on `payment_status` + `pii_pseudonymised_at` nullable + generated `attendee_email_lower` STORED column.
- [X] T008 Create `drizzle/migrations/0129_f6_tenant_webhook_configs_table.sql` per data-model.md § 1.3 — CREATE TABLE `tenant_webhook_configs` with active + grace secret columns + PK `(tenant_id, source)`.
- [X] T009 Create `drizzle/migrations/0130_f6_events_indexes.sql` per data-model.md § 1.1 — 4 indexes on `events` table using `CREATE INDEX CONCURRENTLY` (events_tenant_source_external_unique, events_tenant_start_active_idx, events_tenant_partner_benefit_idx, events_tenant_cultural_event_idx); migration runs OUTSIDE tx via Drizzle `--no-transaction` flag.
- [X] T010 Create `drizzle/migrations/0131_f6_registrations_indexes.sql` per data-model.md § 1.2 — 5 indexes using `CREATE INDEX CONCURRENTLY` (event_regs_tenant_event_external_unique, event_regs_tenant_event_registered_idx, event_regs_tenant_matched_member_idx, event_regs_tenant_email_lower_idx, event_regs_tenant_needs_relink_idx, event_regs_pseudonymise_eligibility_idx); migration runs OUTSIDE tx.
- [X] T011 Create `drizzle/migrations/0132_f6_audit_event_types.sql` per data-model.md § 4 round-2 M1 — 35 × `DO $$ BEGIN ALTER TYPE audit_event_type ADD VALUE 'X'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` blocks (one per F6 event type from the canonical list); each DO-block is its own top-level statement (Postgres restriction on enum extension in tx).
- [X] T012 Create `drizzle/migrations/0133_f6_rls_force_policies.sql` per data-model.md — `ALTER TABLE events ENABLE ROW LEVEL SECURITY; ALTER TABLE events FORCE ROW LEVEL SECURITY; CREATE POLICY events_tenant_isolation ON events USING (tenant_id = current_setting('app.current_tenant', TRUE));` × 3 (events, event_registrations, tenant_webhook_configs) per Constitution Principle I clause 2 (database-layer tenant isolation).
- [X] T013 Create `drizzle/migrations/0134_f6_eventcreate_idempotency_receipts.sql` per data-model.md § 1.4 round-2 M2 — CREATE TABLE `eventcreate_idempotency_receipts(tenant_id, source, request_id, processed_at, ttl_expires_at)` with composite PK + CHECK on source + partial TTL-cleanup index + RLS+FORCE policy. F6-OWNED, not a reuse of F5's processor_events.

### Drizzle Schema

- [X] T014 [P] Create `src/modules/events/infrastructure/schema.ts` with Drizzle schema declarations matching all 4 F6 tables; export type-safe Drizzle inferred types but keep them inside Infrastructure layer (no leak to Application/Domain per Principle III).

### Domain Layer (Value Objects + Aggregates — ZERO framework imports)

- [X] T015 [P] Create `src/modules/events/domain/value-objects/match-type.ts` exporting `MatchType` discriminated union (`'member_contact' | 'member_domain' | 'member_fuzzy' | 'non_member' | 'unmatched'`).
- [X] T016 [P] Create `src/modules/events/domain/value-objects/payment-status.ts` exporting `PaymentStatus` (`'paid' | 'pending' | 'refunded' | 'free'`).
- [X] T017 [P] Create `src/modules/events/domain/value-objects/source.ts` exporting `Source` (`'eventcreate'` extensible).
- [X] T018 [P] Create `src/modules/events/domain/value-objects/webhook-outcome.ts` exporting `WebhookOutcome` + `ProcessingOutcome` discriminated unions per data-model.md § 5.
- [X] T019 [P] Create `src/modules/events/domain/branded-types.ts` exporting branded ID types: `EventId`, `RegistrationId`, `ExternalEventId`, `ExternalAttendeeId`, `AttendeeEmail`, `WebhookSecret`.
- [X] T020 [P] Create `src/modules/events/domain/event.ts` exporting `EventAggregate` interface with `archived_at` lifecycle marker + `metadata` JSONB carrier per data-model.md § 5.
- [X] T021 [P] Create `src/modules/events/domain/event-registration.ts` exporting `EventRegistrationAggregate` + `Attendee` + `MatchResolution` + `Ticket` + `QuotaEffect` interfaces per data-model.md § 5.
- [X] T022 [P] Create `src/modules/events/domain/tenant-webhook-config.ts` exporting `TenantWebhookConfigAggregate` with grace-secret + rotation invariants per research.md R7.
- [X] T023 [P] Create `src/modules/events/domain/eventcreate-payload.ts` exporting zod schemas `EventCreatePayloadV1` + `CsvRowSchema` per data-model.md § 10; `.passthrough()` on event + attendee for FR-011a forward-compat.
- [X] T024 [P] Create `src/modules/events/domain/normalise-company-name.ts` — pure function stripping "Co., Ltd.", "Pte", "AB", "Ltd", "Inc", trailing punctuation, lowercase per research.md R4.
- [X] T025 [P] Create `src/modules/events/domain/levenshtein.ts` — pure DP-table distance function with unit-test fixture per research.md R4; hand-rolled (no library).
- [X] T026 [P] Create `src/modules/events/domain/personal-email-deny-list.ts` exporting static deny list (`gmail.com`, `yahoo.com`, `hotmail.com`, `outlook.com`, `icloud.com`) + tenant-extensible interface per research.md R4.

### Application Ports (Interfaces only — no implementation yet)

- [X] T027 [P] Create `src/modules/events/application/ports/webhook-signature-verifier.ts` exporting `WebhookSignatureVerifier` port interface (verify HMAC + timestamp; supports active + grace secret).
- [X] T028 [P] Create `src/modules/events/application/ports/idempotency-store.ts` exporting `IdempotencyStore` port (insert receipt with ON CONFLICT DO NOTHING semantics).
- [X] T029 [P] Create `src/modules/events/application/ports/attendee-matcher.ts` exporting `AttendeeMatcher` port (4-rule cascade match).
- [X] T030 [P] Create `src/modules/events/application/ports/quota-accounting-port.ts` exporting `QuotaAccountingPort` (queries F2 plan + computes consumed count + decides counted_against flags).
- [X] T031 [P] Create `src/modules/events/application/ports/events-repository.ts` + `registrations-repository.ts` + `tenant-webhook-config-repository.ts` (one file each) exporting repo port interfaces.
- [X] T032 [P] Create `src/modules/events/application/ports/audit-port.ts` per contracts/audit-port.md — exports `F6AuditEventType` closed union (35 events) + `F6AuditEntry<T>` + `F6AuditPort.emit()` + `F6AuditPort.emitRolledBack()` with dual-write fallback contract.
- [X] T033 [P] Create `src/modules/events/application/ports/csv-importer.ts` exporting `CsvImporter` port (stream-parse + per-row idempotency).
- [X] T034 [P] Create `src/modules/events/application/ports/retention-sweeper.ts` exporting `RetentionSweeper` port (pseudonymise stale non-member PII + sweep expired idempotency receipts).
- [X] T035 Update `src/modules/events/index.ts` public barrel to re-export the canonical surface per plan.md § Project Structure: **Domain types** (`EventAggregate`, `EventRegistrationAggregate`, `TenantWebhookConfigAggregate`, `MatchResolution`, `QuotaEffect`, `Attendee`, `Ticket`, `WebhookOutcome`, `ProcessingOutcome`, `MatchType`, `PaymentStatus`, `Source`, branded ID types from T019); **Application port interfaces** (`WebhookSignatureVerifier`, `IdempotencyStore`, `AttendeeMatcher`, `QuotaAccountingPort`, `EventsRepository`, `RegistrationsRepository`, `TenantWebhookConfigRepository`, `F6AuditPort`, `CsvImporter`, `RetentionSweeper`); **Use-case exports** (will be added as each Phase 3-10 task lands: `ingestWebhookAttendee`, `archiveEvent`, `relinkRegistration`, `togglePartnerBenefit`, `toggleCulturalEvent`, `eraseAttendeePii`, `importCsv`, `rotateWebhookSecret`, `runTestWebhook`, `pseudonymiseStaleNonMemberPii`, `getEventAttendeesByMember` for F8 port impl); verify ESLint `no-restricted-imports` rule passes after T003 + T015–T034.

---

## Phase 3: User Story 1 — Automated attendee import via Zapier webhook (Priority: P1)

**Story Goal**: After tenant Zap is configured, every new EventCreate attendee registration appears in Chamber-OS within ~15 min, auto-matched + audit-logged.

**Independent Test**: Configure tenant Zap; POST synthetic signed payload to `/api/webhooks/eventcreate/v1/<tenant>`; verify event row + registration row + audit event + return `{matched, registrationId}`.

### Tests First (TDD — RED phase)

- [X] T036 [P] [US1] Write failing contract test `tests/contract/events/webhook-eventcreate-v1.test.ts` covering every HTTP outcome (200 / 401 sig / 401 replay / 409 dup / 400 malformed / 415 / 429 / 503 / 5xx) per contracts/webhook-eventcreate-api.md.
- [X] T037 [P] [US1] Write failing acceptance E2E `tests/e2e/eventcreate-webhook-ingest.spec.ts` covering US1 AS1–AS5 (happy verify+match+200, non-member persistence, duplicate 409, bad signature 401, timestamp-skew 401); add `@workers=1` per project convention.
- [X] T038 [P] [US1] Write failing integration test `tests/integration/events/signature.test.ts` per plan.md Testing § — valid signature + grace-key within 24h + grace-key at 25h + wrong secret + tampered body + missing header all return identical 401 generic body.
- [X] T039 [P] [US1] Write failing integration test `tests/integration/events/idempotency.test.ts` per plan.md Testing § — same `X-Request-ID` delivered 5× asserts 1 event row + 1 registration + 1 `webhook_receipt_verified` audit + 4 `webhook_duplicate_rejected` audits.
- [X] T040 [P] [US1] Write failing integration test `tests/integration/events/transactional-ingest.test.ts` per plan.md Testing § round-1 E14 — simulate failure at each ACID-unit stage; assert zero partial state + `webhook_rolled_back` audit emitted in separate tx + Zapier-replay-after-recovery commits cleanly.
- [X] T041 [P] [US1] Write failing integration test `tests/integration/events/db-unavailable-during-tx.test.ts` per plan.md Testing § round-1 E14 — close DB connection mid-tx; assert HTTP 5xx + stderr `pino.fatal` with `audit_secondary_tx_failure: true` per research.md R6.
- [X] T042 [US1] Write failing integration test `tests/integration/events/tenant-isolation.test.ts` — Constitution v1.4.0 Principle I clause 3 Review-Gate blocker — creates two tenants, seeds 4 F6 tables, asserts zero cross-tenant visibility on SELECT/INSERT/UPDATE/DELETE + emission of `cross_tenant_probe` audit + payload signed for tenant A POSTed to tenant B's URL → reject + audit. Round-3 Z4 confirmed 4 F6 tables.

### Implementation (GREEN phase — make tests pass)

- [X] T043 [P] [US1] Implement `src/modules/events/application/verify-webhook-signature.ts` use-case per research.md R2 — HMAC-SHA256 + 5-min skew + active + grace-key verify + length-check + try/catch around `crypto.timingSafeEqual` (round-1 E8); generic 401 outcome on any failure.
- [X] T044 [P] [US1] Implement `src/modules/events/infrastructure/crypto-webhook-signature-verifier.ts` adapter using Node `crypto.timingSafeEqual` + standard library SHA-256.
- [X] T045 [P] [US1] Implement `src/modules/events/application/match-attendee-to-member.ts` use-case per research.md R4 — 4-rule cascade (contact-email → domain → fuzzy → non-member); skip domain rule on personal-email deny list; ambiguous fuzzy → `unmatched`.
- [X] T046 [P] [US1] Implement `src/modules/events/infrastructure/drizzle-attendee-matcher.ts` adapter — SQL queries against F3 contacts + members tables (read-only); uses Levenshtein from T025 on normalised company names.
- [X] T047 [US1] Implement `src/modules/events/application/ingest-webhook-attendee.ts` use-case per research.md R6 — strict-transactional ACID unit (event upsert + registration insert + idempotency receipt + quota effect + audit emit all in one Drizzle tx); rollback on any error; separate-tx `webhook_rolled_back` audit + stderr pino.fatal fallback per research.md R6.
- [X] T048 [P] [US1] Implement `src/modules/events/infrastructure/drizzle-events-repository.ts` adapter — `upsert(event)` with ON CONFLICT `(tenant_id, source, external_id) DO UPDATE` returning `event_id, archived_at`.
- [X] T049 [P] [US1] Implement `src/modules/events/infrastructure/drizzle-registrations-repository.ts` adapter — `insert(registration)` with ON CONFLICT `(tenant_id, event_id, external_id) DO NOTHING` (FR-011 second idempotency layer).
- [X] T050 [P] [US1] Implement `src/modules/events/infrastructure/drizzle-idempotency-store.ts` adapter — writes to F6-owned `eventcreate_idempotency_receipts` (round-2 M2); ON CONFLICT DO NOTHING; 7-day TTL via `ttl_expires_at` default.
- [X] T051 [P] [US1] Implement `src/modules/events/infrastructure/pino-audit-port.ts` adapter — emits to `audit_log` with `payload jsonb` carrier (round-2 M1 — NOT `summary` column); writes structured payload + short summary per contracts/audit-port.md; implements `emitRolledBack()` with dual-write stderr fallback per research.md R6.
- [X] T052 [US1] Implement the public webhook receiver at `src/app/api/webhooks/eventcreate/v1/[tenantSlug]/route.ts` — Node runtime (NOT Edge) per plan.md; raw body via `await request.text()` BEFORE any parse; HMAC verify; tenant cross-check (URL vs signature) per FR-006; rate limit 10 req/min/tenant via Upstash (round-2 E13); dispatches to `ingest-webhook-attendee` use-case; returns 200/4xx/5xx per contracts/webhook-eventcreate-api.md.

---

## Phase 4: User Story 2 — Events list + event detail with match-rate visibility (Priority: P1)

**Story Goal**: Admin sees every imported event with match-rate at-a-glance + per-attendee detail with quota effect.

**Independent Test**: Seed 5 events with mixed match types; render `/admin/events` + click into one event; verify list pagination + sortable date + match-rate % + attendee table + deep-link to EventCreate.

### Tests First

- [ ] T053 [P] [US2] Write failing contract test `tests/contract/events/admin-events-api.test.ts` covering GET list + GET detail + filter params + pagination + `emptyStateContext` payload per contracts/admin-events-api.md.
- [ ] T054 [P] [US2] Write failing E2E `tests/e2e/events-list-and-detail.spec.ts` covering US2 AS1–AS5 (list view, event detail, deep link, unmatched filter, **empty-state 3 variants per AS5/CHK028 round-5**).
- [ ] T055 [P] [US2] Write failing a11y E2E `tests/e2e/eventcreate-a11y.spec.ts` (events list + event detail surface) using `@axe-core/playwright`.
- [ ] T056 [P] [US2] Write failing i18n E2E `tests/e2e/eventcreate-i18n.spec.ts` covering EN + TH + SV on events list, event detail, empty-state copy.

### Implementation

- [ ] T057 [P] [US2] Implement `src/modules/events/application/list-events.ts` use-case — paginated query with sort by `start_date DESC` + filter by `includeArchived` + `categoryFilter` + `partnerBenefitOnly` + `culturalEventOnly`; returns items + pagination + `emptyStateContext` per contracts/admin-events-api.md.
- [ ] T058 [P] [US2] Implement `src/modules/events/application/load-event-detail.ts` use-case — single event fetch + paginated attendees + match-rate aggregate + `unmatchedOnly` filter + `q` substring search on attendee_email_lower + attendee_name.
- [ ] T059 [P] [US2] Add `getEventsListEmptyContext(tenantId)` query helper in `drizzle-events-repository.ts` — returns `{integrationConfigured, everReceivedDelivery, totalArchived}` so the UI can render 3-variant empty-state per US2 AS5 / CHK028.
- [ ] T060 [US2] Implement route handler `src/app/api/admin/events/route.ts` (GET list) + `src/app/api/admin/events/[eventId]/route.ts` (GET detail) — applies F1 session middleware + FR-035 RBAC matrix (admin + manager read-only; member → 404).
- [ ] T061 [P] [US2] Implement `src/components/events/events-list-table.tsx` using TanStack Table v8 (mirrors F3 directory + F4 invoice-list pattern) with columns Date / Name / Category / Registrations / Partner Benefit badge / Match Rate %; keyboard nav + a11y landmarks.
- [ ] T062 [P] [US2] Implement `src/components/events/event-detail-header.tsx` showing event metadata + aggregate match-rate indicator + "View on EventCreate" deep-link button + "Archived" badge when applicable.
- [ ] T063 [P] [US2] Implement `src/components/events/attendee-table.tsx` with paginated/searchable rows + match-status badge + quota-effect badge + "Show unmatched only" filter button (US2 AS4); virtualised at >500 rows.
- [ ] T064 [P] [US2] Implement `src/components/events/match-status-badge.tsx` + `quota-effect-badge.tsx` reusable primitives using shadcn/ui Badge + shape+text+colour (NOT colour-alone for WCAG 2.1 AA contrast compliance).
- [ ] T065 [P] [US2] Implement `src/app/(staff)/admin/events/page.tsx` (list page) + `loading.tsx` shimmer skeleton; renders 3-variant empty-state per CHK028 round-5 fix with localised CTAs (EN/TH/SV).
- [ ] T066 [P] [US2] Implement `src/app/(staff)/admin/events/[eventId]/page.tsx` (detail page) + `loading.tsx` shimmer skeleton.
- [ ] T067 [US2] Populate `src/i18n/messages/{en,th,sv}.json` with events-list + event-detail i18n keys (~40 keys × 3 = ~120 entries) including empty-state 3 variants; run `pnpm check:i18n`.

---

## Phase 5: User Story 3 — Tenant onboarding wizard (Priority: P1)

**Story Goal**: Fresh tenant admin completes EventCreate Zap setup end-to-end (URL + secret + Zapier walkthrough + test webhook) in <15 min (SC-001).

**Independent Test**: Open `/admin/integrations/eventcreate` on fresh tenant; complete wizard; press "Test webhook"; see green confirmation within 30s with synthetic delivery in recent-deliveries panel.

### Tests First

- [ ] T068 [P] [US3] Write failing contract test `tests/contract/events/admin-integration-eventcreate-api.test.ts` covering GET (config view + emptyStateContext + includeTestDeliveries filter) + POST generate-secret + rotate-secret + test-webhook + disable per contracts/admin-integration-eventcreate-api.md.
- [ ] T069 [P] [US3] Write failing E2E `tests/e2e/integration-config-wizard.spec.ts` covering US3 AS1–AS3 (one-time-reveal + checkbox gate + Zapier walkthrough + test webhook button + recent-deliveries panel).

### Implementation

- [ ] T070 [P] [US3] Implement `src/modules/events/application/generate-webhook-secret.ts` use-case — generates 32-byte cryptographic random base64url secret; 409 Conflict if secret already exists; emits `webhook_secret_generated` audit per research.md R7.
- [ ] T071 [P] [US3] Implement `src/modules/events/application/rotate-webhook-secret.ts` use-case — moves active to grace + sets `grace_rotated_at = NOW()` + generates new active + emits `webhook_secret_rotated` audit; rate-limited 3/hour per (tenant, actor).
- [ ] T072 [P] [US3] Implement `src/modules/events/application/run-test-webhook.ts` use-case — generates synthetic payload with sentinel `event_external_id='__test_webhook__'` + `attendee_external_id='__test_webhook__-<ts>'`; signs with active secret; POSTs to own webhook URL; receiver short-circuits per contracts/admin-integration-eventcreate-api.md round-2 P8 (no event/registration row created); emits `webhook_test_invoked` audit.
- [ ] T073 [P] [US3] Implement `src/modules/events/infrastructure/drizzle-tenant-webhook-config-repository.ts` adapter — CRUD operations + grace-key expiry logic + RLS-scoped queries.
- [ ] T074 [US3] Implement route handlers under `src/app/api/admin/integrations/eventcreate/` — `generate-secret/route.ts`, `rotate-secret/route.ts`, `test-webhook/route.ts`, `recent-deliveries/route.ts`; non-admin returns 404 per FR-035 (surface-disclosure prevention; round-2 E17). The `recent-deliveries/route.ts` handler queries `audit_log` directly (no separate Application-layer use-case — read-only audit query is simple enough to live inline; if complexity grows, extract to `list-recent-deliveries.ts` Application use-case later — per analyze finding C-1).
- [ ] T075 [P] [US3] Implement `src/components/events/webhook-config-wizard.tsx` — 3-phase progressive disclosure: generate-secret → walkthrough acknowledged → test-webhook + recent-deliveries panel. Default-filter sentinel test rows per round-2 R5.
- [ ] T076 [P] [US3] Implement `src/components/events/webhook-secret-reveal.tsx` — one-time-reveal panel with copy-to-clipboard + "I've saved this in a password manager" checkbox that gates phase 2 per FR-024.
- [ ] T077 [P] [US3] Implement `src/components/events/rotate-secret-dialog.tsx` with confirmation step + grace-window-active-until display.
- [ ] T078 [P] [US3] Implement `src/components/events/recent-deliveries-panel.tsx` with `includeTestDeliveries=false` default filter per round-2 R5 + toggle to show all.
- [ ] T079 [P] [US3] Implement `src/components/events/test-webhook-button.tsx` with loading state + success/failure outcome rendering per contracts/admin-integration-eventcreate-api.md.
- [ ] T080 [US3] Implement `src/app/(staff)/admin/integrations/eventcreate/page.tsx` + `loading.tsx` rendering the wizard; commit EN screenshots + i18n narration to `public/walkthroughs/eventcreate-zapier/` (8 step images + Markdown body in {en,th,sv}.json + "Zapier UI is English only" localised notice per Session 2026-05-12 round 3 Q3 / R12).
- [ ] T081 [US3] Implement nav-visibility logic per round-2 R1 — hide `/admin/integrations/eventcreate` from admin sidebar when no `tenant_webhook_configs` row exists AND `last_received_at IS NULL` for 30d; reachable via direct URL.

---

## Phase 6: User Story 4 — Benefit quota accounting on attendance (Priority: P2)

**Story Goal**: Matched member's quota counter decrements on registration; credit-back on refund/archive; over-quota persisted with warning.

**Independent Test**: Diamond Partnership member with 6 tickets → 6 registrations counted; 7th = `counted=false`; cultural-flagged registration on Premium member decrements annual quota; refund credits back.

### Tests First

- [ ] T082 [P] [US4] Write failing E2E `tests/e2e/quota-accounting.spec.ts` covering US4 AS1–AS4 (partnership-6 decrement, over-quota 7th, cultural annual, refund credit-back).
- [ ] T083 [P] [US4] Write failing property-based integration test `tests/integration/events/quota-concurrency.test.ts` using `fast-check@^4` (existing F4/F8 devDep) per research.md R5 — 10 concurrent ingest workers × 100 random schedules; assert `SUM(counted_against_partnership) ≤ allotment` (SC-004 zero-error promise).
- [ ] T084 [P] [US4] Write failing integration test `tests/integration/events/quota-accounting.test.ts` covering refund credit-back + archive credit-back + over-quota `quota_over_quota_warning` audit emission.

### Implementation

- [ ] T085 [P] [US4] Implement `src/modules/events/application/apply-quota-effect.ts` use-case per research.md R5 round-3 Z1 — (a) acquire `pg_advisory_xact_lock(hashtextextended('eventcreate-quota:' || tenant_id || ':' || matched_member_id || ':' || event_id, 0))`; (b) call F2 barrel `getMemberPlanForBucket(memberId)`; (c) `SELECT count(*) FROM event_registrations` for consumed count; (d) write registration with `counted_against_* = (consumed < allotment)`; (e) emit `quota_partnership_decremented` / `quota_cultural_decremented` / `quota_over_quota_warning` audit. Canonical SQL order per round-2 R2: BEGIN → SET LOCAL → advisory_lock → ... → COMMIT.
- [ ] T086 [P] [US4] Implement `src/modules/events/infrastructure/drizzle-quota-accounting-adapter.ts` adapter wrapping F2 + F3 read-only calls; bridges Domain `QuotaAccountingPort` to Drizzle.
- [ ] T087 [P] [US4] Implement `src/modules/events/application/toggle-event-category.ts` use-case (FR-019) — toggles `is_partner_benefit` or `is_cultural_event`; re-evaluates all registrations' quota effects in one tx; emits `event_partner_benefit_toggled` or `event_cultural_event_toggled` + N × quota change events.
- [ ] T088 [US4] Implement route handler `src/app/api/admin/events/[eventId]/toggle-partner-benefit/route.ts` + `toggle-cultural-event/route.ts` (admin-only; FR-035).
- [ ] T089 [P] [US4] Add quota-related i18n keys (~15 keys × 3 = 45 entries) covering "over quota" warning + "X tickets remaining" + audit-event-type human-readable descriptions for `quota_*` events.

---

## Phase 7: User Story 5 — CSV import (primary path for non-EventCreate tenants + backfill) (Priority: P2)

**Story Goal**: Upload CSV of attendee data; same matching + quota logic as webhook; clear result report with `rowsAlreadyImported` count for repeat uploads.

**Independent Test**: Upload 50-row CSV across 5 events; verify preview + import + result summary matches equivalent webhook deliveries; re-upload same file → 0 new + 50 already-imported.

### Tests First

- [ ] T090 [P] [US5] Write failing contract test `tests/contract/events/csv-import-api.test.ts` covering header validation + valid + invalid rows + 413 file-too-large + 429 rate-limit + 504 timeout + result summary shape with `rowsAlreadyImported` per contracts/csv-import-api.md.
- [ ] T091 [P] [US5] Write failing E2E `tests/e2e/csv-fallback-import.spec.ts` covering US5 AS1–AS3 (preview, 1k-row import within 60s SC-006, error report).
- [ ] T092 [P] [US5] Write failing integration test `tests/integration/events/csv-webhook-equivalence.test.ts` per plan.md Testing § round-1 E15 — same 100 attendees via webhook vs CSV; hash-and-compare snapshots of `events` + `event_registrations` rows (modulo timestamps + UUIDs).

### Implementation

- [ ] T093 [P] [US5] Implement `src/modules/events/infrastructure/streaming-csv-importer.ts` adapter — Node Readable + `readline` over the multipart buffer; hand-rolled parser supporting the strict format per research.md R8 round-1 E20 (UTF-8 + BOM strip + LF/CRLF + commas + double-quote escape with `""`; rejects embedded newlines, semicolon separators, trailing commas, mixed quoting); commit test fixtures under `tests/integration/events/csv-fixtures/` (happy-1000-rows, with-bom, crlf, quoted-comma, escaped-quote + 3 malformed).
- [ ] T094 [P] [US5] Implement `src/modules/events/application/import-csv.ts` use-case — orchestrates streaming-parse + per-row zod-validate + idempotency receipt + match-attendee + apply-quota-effect + audit emission; batched 100 rows per tx; per-row failure isolation; tracks `rowsAlreadyImported` separately from `rowsProcessed` per round-2 R3.
- [ ] T095 [US5] Implement route handler `src/app/api/admin/events/import/route.ts` — `multipart/form-data` parser; max 5 MiB file size with 413 response; rate limit 5 imports/hour per (tenant, actor); admin-only RBAC; result summary per contracts/csv-import-api.md.
- [ ] T096 [P] [US5] Implement `src/components/events/csv-mapping-form.tsx` — drag-drop file input + 10-row preview + auto-detected column mapping with admin remap option per Spec §FR-026.
- [ ] T097 [P] [US5] Implement `src/components/events/csv-import-result.tsx` — result summary card with `rowsProcessed` + `rowsAlreadyImported` (distinguish from "0 actually delivered" per round-2 R3) + per-match-type counts + error-row list with row number + reason.
- [ ] T098 [P] [US5] Implement `src/app/(staff)/admin/events/import/page.tsx` + `loading.tsx` — CSV import workflow page; admin-only access.
- [ ] T099 [P] [US5] Add CSV-import i18n keys (~25 keys × 3 = 75 entries) covering preview + mapping + result summary + error messages.

---

## Phase 8: User Story 7 — Webhook secret rotation with grace period (Priority: P2)

**Story Goal**: Admin rotates webhook secret with 24h grace window; old secret continues to verify within grace; rejected after 25h.

**Independent Test**: Rotate at T; webhook signed with old secret at T+12h verifies; at T+25h rejects with 401.

### Tests First

- [ ] T100 [P] [US7] Write failing E2E `tests/e2e/secret-rotation.spec.ts` covering US7 AS1–AS3 (rotate + 12h grace verify + 25h reject) using time-mock or fixture-controlled clock.

### Implementation

(Most US7 implementation is covered by T070 (generate-webhook-secret) + T071 (rotate-webhook-secret) + T043 (verify-webhook-signature with grace-key support). This phase adds the grace-expiry cleanup + audit.)

- [ ] T101 [US7] Extend `src/modules/events/application/verify-webhook-signature.ts` (from T043) with explicit grace-key fallback path — try active first; if mismatch AND `grace_rotated_at > NOW() - INTERVAL '24 hours'`, try grace via second `timingSafeEqual`; on grace-success emit `webhook_secret_grace_used` audit. Mirror unit test coverage per research.md R7.
- [ ] T102 [P] [US7] Add grace-key i18n keys covering rotation dialog + 24h-grace-info banner copy.

---

## Phase 9: User Story 6 — Manual relink for unmatched / mis-matched attendees (Priority: P3)

**Story Goal**: Admin manually re-links registration to correct member; quota credit-back-and-recompute; pseudonymised rows disallowed.

**Independent Test**: Seed registration with `match_type='non_member'`; admin relinks to Member A; verify match_type + matched_member_id + quota effect update + audit.

### Tests First

- [ ] T103 [P] [US6] Write failing E2E `tests/e2e/relink-attendee.spec.ts` covering US6 AS1–AS2 (non-member → member relink, A → B quota credit-back-and-recompute, **pseudonymised-row disallowed message per round-2 R4 / FR-014**).

### Implementation

- [ ] T104 [P] [US6] Implement `src/modules/events/application/relink-registration.ts` use-case per FR-014 — guards against `pii_pseudonymised_at IS NOT NULL` (returns Result.err with UX-message constant per round-2 R4); credit-back old member quota + re-evaluate new member quota (calls `apply-quota-effect` reuse); audit `registration_relinked` with previous/new member IDs + quota impact.
- [ ] T105 [US6] Implement route handler `src/app/api/admin/events/[eventId]/registrations/[registrationId]/relink/route.ts` (admin-only; FR-035).
- [ ] T106 [P] [US6] Implement `src/components/events/relink-dialog.tsx` — searchable member picker (autocomplete from F3 members) + "Cannot relink — attendee PII has been retention-purged" UX message when target row is pseudonymised per FR-014 round-2 R4.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Archive lifecycle, PII erasure, retention sweeps, F8 port adapter, all observability instrumentation, perf benches, retrospective, final review.

### Archive + Erasure (FR-019a + FR-032a)

- [ ] T107 [P] Implement `src/modules/events/application/archive-event.ts` use-case (FR-019a) — admin-only; sets `archived_at = NOW()`; reverses all `counted_against_*` flags + credits back quotas + emits `event_archived` + N × `quota_credit_back_archive` audits.
- [ ] T108 Implement route handler `src/app/api/admin/events/[eventId]/archive/route.ts` (admin-only).
- [ ] T109 [P] Implement `src/components/events/archive-event-dialog.tsx` + `src/app/(staff)/admin/events/archived/page.tsx` for archived-events filter view.
- [ ] T110 [P] Implement `src/modules/events/application/erase-attendee-pii.ts` use-case (FR-032a) — admin-only; deletes registration row + reverses quota + emits `pii_erasure_requested` + `pii_erasure_completed` + `quota_credit_back_*`; idempotent on re-invocation.
- [ ] T111 Implement route handler `src/app/api/admin/events/[eventId]/registrations/[registrationId]/erase/route.ts` (admin-only).
- [ ] T112 [P] Implement `src/components/events/erase-pii-dialog.tsx` + `src/app/(staff)/admin/events/[eventId]/registrations/[registrationId]/erase/page.tsx` for confirmation + reason form.

### Retention Sweeps (FR-032 + Z5)

- [ ] T113 [P] Implement `src/modules/events/application/pseudonymise-stale-non-member-pii.ts` use-case per research.md R9 — multi-tenant iteration via super-admin enumeration → `runInTenant` per tenant per round-1 E18; deterministic salted hash; emit `pii_pseudonymised` audit per row + `pii_pseudonymisation_sweep_run` aggregate audit; metric `eventcreate_pseudonymisation_sweep_rows_total`.
- [ ] T114 Implement cron handler `src/app/api/internal/retention/pseudonymise-eventcreate/route.ts` (daily 03:00 Asia/Bangkok; Bearer-auth via `CRON_SECRET`).
- [ ] T115 [P] Implement TTL sweep use-case `src/modules/events/application/sweep-stale-idempotency-receipts.ts` per round-3 Z5 — deletes rows where `ttl_expires_at < NOW()` per tenant; emits structured pino log with duration + tenants-scanned + per-tenant deletedCount; metric `eventcreate_idempotency_sweep_rows_total` per round-4 AA1.
- [ ] T116 Implement cron handler `src/app/api/internal/retention/sweep-eventcreate-idempotency/route.ts` (daily 04:00 Asia/Bangkok; Bearer-auth) per round-3 Z5.
- [ ] T117 [P] Write failing integration test `tests/integration/events/retention-sweep.test.ts` per plan.md Testing § (seed 1k non-member registrations at varying ages, run cron, assert pseudonymisation correctness + member-linked rows untouched + audit emission + quota preserved).
- [ ] T118 [P] Write failing integration test `tests/integration/events/idempotency-ttl-sweep.test.ts` per round-4 AA2 — seed mixed-expiry rows across two tenants, run cron, assert correct deletion + metric increment + cross-tenant isolation + stderr pino log emission for AA1 stalled-sweep alert.
- [ ] T119 [P] Write failing integration test `tests/integration/events/pii-erasure.test.ts` per plan.md Testing § — admin erases registration with counted quota; assert PII deleted + quota credited + audit emitted + aggregate stats unaffected.

### F8 Port Adapter Wiring (X3 + E16)

- [ ] T120 [P] Implement `src/modules/events/application/get-event-attendees-by-member.ts` use-case — Application-layer wrapper enforcing `runInTenant` boundary + mapping Drizzle types to Domain VOs per research.md R11 round-2 E1.
- [ ] T121 [P] Implement `src/modules/events/infrastructure/drizzle-event-attendees-by-member.ts` adapter — queries F6 `event_registrations` by `matched_member_id` with `payload jsonb` return shape suitable for F8's at-risk score consumption.
- [ ] T122 Wire F6 adapter into F8's composition root — update `src/app/(staff)/admin/renewals/...` route loaders + `src/app/api/cron/renewals/...` cron handlers per quickstart.md § 2.2 to conditional-swap stub for F6 adapter when `FEATURE_F6_EVENTCREATE === 'true'`. **Critical seam — silent-failure risk: if forgotten, F8 stays on stub forever** (analyze finding U-1). Verification by T123 (F8-port-wiring integration test) at code level + T154a (human-gate verification at flag-flip time) at deploy level.
- [ ] T123 [P] Write failing integration test `tests/integration/events/f8-port-wiring.test.ts` per plan.md Testing § round-1 X3 — flag on → F8 sees real attendance data; flag off → F8 falls back to stub.

### Observability (FR-036 — 11 metrics + 6 alerts + 3 runbooks)

- [ ] T124 [P] Wire OTel metric `eventcreate_webhook_receipts_total` (counter; labels `tenant_id`, `signature_outcome`, `processing_outcome`) into `ingest-webhook-attendee.ts` + signature-failure paths.
- [ ] T125 [P] Wire OTel metric `eventcreate_webhook_ingest_latency_seconds` (histogram p50/p95/p99; labels `tenant_id`) at the webhook route handler entry/exit.
- [ ] T126 [P] Wire OTel metric `eventcreate_match_rate_gauge` (rolling 30-day per tenant) via a scheduled refresh function.
- [ ] T127 [P] Wire OTel metric `eventcreate_csv_import_duration_seconds` (histogram; labels `tenant_id`, `row_count_bucket`) into `import-csv.ts`.
- [ ] T128 [P] Wire OTel metrics `eventcreate_partnership_quota_decrement_total` + `eventcreate_cultural_quota_decrement_total` + `eventcreate_refund_credit_back_total` (counters; labels `tenant_id`, `member_id_hash`) into `apply-quota-effect.ts` + refund handler.
- [ ] T129 [P] Wire OTel metrics `eventcreate_secret_rotation_total` + `eventcreate_ingest_disabled_tenant_gauge` (counter + gauge) into rotation + disable use-cases.
- [ ] T130 [P] Wire OTel metrics `eventcreate_pseudonymisation_sweep_rows_total` + `eventcreate_idempotency_sweep_rows_total` (counters; labels `tenant_id`) into the two retention cron handlers (T114 + T116).
- [ ] T131 [P] Configure 6 alert rules in Vercel log-based alert config (signature-rejection burst, match-rate drop, webhook p95 over budget, CSV failure spike, ingest-disabled tenant, idempotency-sweep stalled per AA1) → Resend email to maintainer per research.md R10.
- [ ] T132 [P] Author runbook `docs/runbooks/eventcreate-signature-failure-investigation.md` per research.md R10 runbook #1 (5 most-likely root causes + triage steps).
- [ ] T133 [P] Author runbook `docs/runbooks/eventcreate-match-rate-degradation-triage.md` per research.md R10 runbook #2 (link to F3 member-onboarding-pace check).
- [ ] T134 [P] Author runbook `docs/runbooks/eventcreate-secret-rotation-procedure.md` per research.md R10 runbook #3 (end-to-end rotation + Zapier update + verify with test webhook).
- [ ] T135 Document cron-job.org coordinator setup (2 entries — pseudonymise + idempotency-sweep) in `docs/runbooks/cron-jobs.md` alongside existing F4–F8 entries per quickstart.md § 2.3 round-3 Z5.

### Performance Benchmarks (E5 + E12 + SC-003 + SC-006)

- [ ] T136 [P] Implement perf bench `bench/events/webhook-ingest-latency.ts` — generate signed payload + measure p95 latency at design envelope (50k regs/yr/tenant + 60 req/min sustained per SC-003 / FR-005); assert <300ms p95.
- [ ] T137 [P] Implement perf bench `bench/events/events-list-render.ts` — measure list page p95 at 100 events × 500 attendees per plan.md Performance Goals; assert <500ms p95.
- [ ] T138 [P] Implement perf bench `bench/events/csv-import-memory.ts` per round-1 E5 — profile peak heap during 1k + 5k row CSV imports; assert peak <500 MiB (fail-fast).
- [ ] T139 [P] Implement perf bench `bench/events/attendee-fuzzy-match.ts` per round-1 E12 — measure `match-attendee-to-member.ts` p95 at 5k-member fixture; assert <50ms per ingest. If fail, fallback strategy is pg_trgm (decision per bench result).

### RBAC + Manager Read-Only Verification

- [ ] T140 [P] Write failing E2E `tests/e2e/manager-readonly-events.spec.ts` per plan.md Testing § — manager sees events list + detail; mutating CTAs absent; direct API POST returns 403 + `role_violation_blocked` audit.
- [ ] T141 [P] Write failing integration test `tests/integration/events/rbac-defence-in-depth.test.ts` — manager role POSTs to every F6 mutating endpoint; assert 403 + `role_violation_blocked` audit + zero state mutation (defence-in-depth alongside UI-hide tests).

### i18n Completeness + Audit Event Descriptions

- [ ] T142 [P] Populate `src/i18n/messages/{en,th,sv}.json` with all 35 F6 audit-event-type human-readable descriptions under `audit.eventcreate.*` keys.
- [ ] T143 Run `pnpm check:i18n` and assert zero missing keys across EN + TH + SV (release-branch CI gate per Constitution V).

### Final Integration + E2E Sweep

- [ ] T144 Run full E2E suite with `pnpm test:e2e tests/e2e/eventcreate-*.spec.ts --workers=1` (per CLAUDE.md memory feedback_e2e_workers); assert all 10 E2E specs green. **Audit-completeness invariant assertion (per analyze findings C-2 + C-3 / FR-009 / SC-007)**: as part of the suite teardown, query `audit_log` for the test run window and assert `count(audit_log WHERE event_type IN webhook_outcome_event_types) === count(all webhook deliveries fired during the run)` — proves 100% of webhook deliveries are reflected in the audit log with the correct outcome categorisation.
- [ ] T145 Run axe-core a11y scan with `pnpm test:e2e --grep "@a11y" --workers=1`; assert WCAG 2.1 AA on all 4 F6 admin surfaces.
- [ ] T146 Run full integration suite against live Neon Singapore with `pnpm test:integration --filter events`; assert ≥10 integration specs green.
- [ ] T147 Run cross-tenant probe (Review-Gate blocker per Constitution Principle I clause 3) with `pnpm test:integration tests/integration/events/tenant-isolation.test.ts` — must be GREEN before review.

### Retrospective Stubs (SC-002 + SC-005 Measurement Plans)

- [ ] T148 [P] Create `specs/012-eventcreate-integration/retrospective.md` stub with placeholders for: (a) SC-002 30-day post-flag-flip match-rate measurement via `eventcreate_match_rate_gauge` (round-1 P11); (b) SC-005 baseline + 3-event post-flag-flip time measurements per Session 2026-05-12 round 3 Q4 protocol; (c) screenshot-staleness 6-month review log per research.md R12 round-1 P9.
- [ ] T149 Update `CLAUDE.md` Recent Changes section with F6 review-ready status + final test counts + 4-round critique-history summary per F8 precedent.

### Pre-Ship Human-Gated Items (deferred to flag-flip)

- [ ] T150 [Human gate] Maintainer co-signs F6 security checklist (`specs/012-eventcreate-integration/checklists/security.md` all 38 items resolved) per Constitution IX.5 solo-maintainer substitute.
- [ ] T151 [Human gate] Maintainer signs off reliability + ux + observability + integration checklists (3 × 35-40 items resolved).
- [ ] T152 [Human gate] Run `/speckit.qa.run` (or equivalent) full E2E + a11y + i18n pass on staging before flag-flip per F8 precedent.
- [ ] T153 [Human gate] Manual measurement of SC-005 baseline (1 pre-flag-flip event) recorded in retrospective.md.
- [ ] T154 [Human gate] Configure 2 cron-job.org coordinators (`pseudonymise-eventcreate` + `sweep-eventcreate-idempotency`) in cron-job.org dashboard; verify Bearer auth + URL + schedule + first-pass success per quickstart.md § 2.3.
- [ ] T154a [Human gate] **F8 port adapter live-wired verification (per analyze finding U-1)**: at flag-flip time, query F8's at-risk score for a member with seeded event attendance + assert score reflects real attendance data (NOT empty stub). Confirms T122 composition-root swap is active in production. Equivalent assertion at staging during T152 staging walkthrough is acceptable.

---

## Dependency Graph (User Story Completion Order)

```
Phase 1 (Setup) ──> Phase 2 (Foundational) ──┬──> Phase 3 (US1 — P1) ──┬──> Phase 6 (US4 — P2)
                                              ├──> Phase 4 (US2 — P1)   ├──> Phase 7 (US5 — P2)
                                              └──> Phase 5 (US3 — P1)   └──> Phase 8 (US7 — P2)
                                                                              │
                                                                              └──> Phase 9 (US6 — P3)
                                                                                    │
                                                                                    └──> Phase 10 (Polish + Cross-Cutting)
```

- **Phase 2 is blocking** — every user-story phase reads/writes the 4 F6 tables + uses the audit-port + ports defined in Phase 2.
- **US1 + US2 + US3 are mutually independent** within Phase 3+4+5 — can be implemented in any order or parallel.
- **US4 (quota) depends on US1** (registration ingest must exist before quota effect applies).
- **US5 (CSV) depends on US1** (uses the same match + quota use-cases).
- **US7 (rotation grace) depends on US3** (rotation flow) + **US1** (signature verification with grace fallback).
- **US6 (relink) depends on US2** (event-detail UI hosts the relink dialog) + **US4** (quota credit-back-and-recompute).
- **Phase 10 polish** runs **after all user stories ship** but contains parallel-safe tasks; can interleave with US-phase polish work.

## Parallel Execution Examples per User Story

**Phase 2 — maximum parallelism opportunity**: T015–T034 are all `[P]` (different files; no inter-dependencies). Estimated 1-day window if launched simultaneously.

**Phase 3 (US1) — 8 parallel tasks within the GREEN phase**: T044, T045, T046, T048, T049, T050, T051 are `[P]` (different files; depend only on Phase 2 + Domain types).

**Phase 4 (US2) — 6 parallel tasks within the implementation phase**: T057, T058, T061, T062, T063, T064 are `[P]`.

**Phase 5 (US3) — 7 parallel tasks within the implementation phase**: T070, T071, T072, T073, T075, T076, T077, T078, T079 are `[P]`.

**Phase 10 polish — large parallel surface**: T107, T110, T120, T121, T124–T130, T132–T134, T136–T139, T140, T141, T142 are all `[P]`.

## MVP Scope (recommended first iteration)

**MVP = Phase 1 + Phase 2 + Phase 3 (US1) + Phase 4 (US2) + Phase 5 (US3)** — delivers webhook ingest + admin visibility + tenant onboarding for SweCham. Estimated ~80 tasks (T001–T081). Manager / member / quota accounting / CSV / relink / rotation grace + all polish can ship in a follow-up increment.

**MVP independent test criteria**:
- US1 alone: A signed Zapier-style webhook produces an event row + registration row + audit event (no UI required for US1's test).
- US2 alone: A pre-seeded events table renders correctly with pagination + filters + empty-state.
- US3 alone: Fresh tenant completes Zap setup in <15 min.

After MVP, increments add value without re-architecture per the independent-testability discipline.

## Format Validation

All 154 tasks follow `[ ] T### [P?] [USx?] Description with file path`:
- ✅ Checkbox `- [ ]` on every line
- ✅ Sequential IDs T001–T154
- ✅ `[P]` marker only on parallelisable tasks (different files; no waiting on incomplete tasks)
- ✅ `[USx]` label on every user-story-phase task; ABSENT on Phase 1 Setup / Phase 2 Foundational / Phase 10 Polish per template rules
- ✅ Every task includes exact file path or command

## Summary

| Phase | Tasks | Notes |
|---|---|---|
| 1 — Setup | T001–T005 (5) | Feature flag + module scaffolding |
| 2 — Foundational | T006–T035 (30) | 8 migrations + Drizzle schema + 12 Domain VOs + 8 ports + barrel |
| 3 — US1 (webhook) | T036–T052 (17) | TDD: 7 failing tests + 10 implementation tasks |
| 4 — US2 (list/detail) | T053–T067 (15) | 4 failing tests + 11 implementation |
| 5 — US3 (wizard) | T068–T081 (14) | 2 failing tests + 12 implementation |
| 6 — US4 (quota) | T082–T089 (8) | 3 failing tests + 5 implementation |
| 7 — US5 (CSV) | T090–T099 (10) | 3 failing tests + 7 implementation |
| 8 — US7 (rotation grace) | T100–T102 (3) | 1 failing test + 2 implementation (most logic in T043+T070+T071) |
| 9 — US6 (relink) | T103–T106 (4) | 1 failing test + 3 implementation |
| 10 — Polish + Cross-Cutting | T107–T154a (49) | Archive + erase + retention sweeps + F8 wiring + 11 metrics + 6 alerts + 3 runbooks + 4 perf benches + RBAC verify + i18n + final E2E + retrospective + 6 human gates (T150–T154a; T154a added per round-1 U-1 — F8 port live-wired verification at flag-flip) |
| **TOTAL** | **155 tasks** | **~80 MVP / ~75 post-MVP polish** |

Estimated solo-maintainer effort: ~25–30 days for full F6 (per F8 precedent of ~285 tasks ≈ ~6 weeks; F6 is ~54% the size).
