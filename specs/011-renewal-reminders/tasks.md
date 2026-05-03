# Tasks: F8 — Renewal Tracking + Smart Reminders

**Branch**: `011-renewal-reminders` | **Date**: 2026-05-03 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Constitution**: v1.4.0
**Total tasks**: ~290 across 10 phases (extended at /speckit.tasks audit M1-M4 + R1-R5)
**Production gate**: F8 ships dark; flips on at MVP-wide chamber go-live (Option C per /speckit.clarify round-3 + maintainer clarification 2026-05-03)

---

## Phase 1 — Setup (Module skeleton + env vars + dependencies)

**Goal**: Initialise `src/modules/renewals/` module skeleton, env-var validation, ESLint barrel rules, no new npm dependencies. Phase exits with `pnpm install` + `pnpm typecheck` + `pnpm lint` green on empty F8 module.

- [X] T001 Verify F8 branch checked out + clean main per `pnpm install` `pnpm typecheck` `pnpm lint` `pnpm test --run` baseline green ✓ 2026-05-03 (287 files / 3175 tests / 257s)
- [X] T002 Create empty bounded-context skeleton at `src/modules/renewals/{domain,application,infrastructure,application/ports}/.gitkeep` plus empty barrel `src/modules/renewals/index.ts` ✓ 2026-05-03 (5 new files)
- [X] T003 Extend `src/lib/env.ts` zod schema with F8 env vars: `FEATURE_F8_RENEWALS` (boolean default false), `FEATURE_F8_AT_RISK_DISABLED` (boolean default false), `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` (string ≥32 bytes), `RENEWAL_LINK_TOKEN_SECRET_FALLBACK` (string ≥32 bytes optional). Add new accessor block `env.renewals.*` ✓ 2026-05-03 (4 schema fields + features extension + renewals block + .env.example doc + .env.local secret generated via openssl)
- [X] T004 Update `eslint.config.mjs` — added `src/modules/renewals/**` to barrel-only enforcement ignores list (line 213 area) + new cross-module barrel rule block mirroring F7 broadcasts pattern (line 337 area). Domain/Application forbidden-imports lists unchanged because F8 introduces no new SDKs (reuses F1+F4 transactional Resend already in allowlist). ✓ 2026-05-03 (2 edits, lint green)
- [X] T005 [P] Document the 6 cron-job.org jobs (3 main + 3 housekeeping) in `docs/runbooks/cron-jobs.md` (extends F7 runbook): job-catalogue + per-endpoint Bearer setup + secret rotation procedure + R17 threat model ✓ 2026-05-03 (6 catalogue rows + 6 H2 setup-procedure sections appended before § Owner)
- [X] T006 Verify Phase 1 checkpoint: `pnpm install` + `pnpm typecheck` + `pnpm lint` + `pnpm test --run` GREEN with empty F8 module ✓ 2026-05-03 (287 test files / 3175 tests / 266s — zero regressions vs T001 baseline; all 4 baseline commands GREEN)

---

## Phase 2 — Foundational (Cross-module PRs + migrations + Domain skeleton + RLS)

**Goal**: Land coordinated F4 callback PR + F2 schedule-plan-change use-case (table delivered by F8 PR), generate 9 migrations 0086-0094, RLS+FORCE policies, Domain entities + value objects + Application ports, composition root scaffold. Phase exits with cross-tenant integration test scaffold green on empty data.

### F4 Callback Coordinated PR (per Complexity Tracking #3)

- [X] T007 Author F4 callback contract test at `tests/contract/f4-on-paid-callbacks.contract.test.ts` — assert callback fires once per state-transition + rollback path on callback failure (5 contracts: fires-once + canonical-shape + rollback + sequential-order + opt-in regression)
- [X] T008 Extend F4's `markPaidFromProcessor` use-case in `src/modules/invoicing/application/mark-paid-from-processor.ts` with optional `onPaidCallbacks: ((evt: F4InvoicePaidEvent) => Promise<void>)[]` parameter — DEVIATION: callbacks live on `RecordPaymentDeps` (composition-root surface) instead of input shape, threaded through `makeRecordPaymentDeps(tenantId, externalTx?, onPaidCallbacks?)` so admin manual mark-paid + F5 webhook + F8 manual mark-paid all benefit. Wrapper input forwards via 3rd param. Callback invocation host = `record-payment.ts` after `applyPayment` + audit + outbox + reg-fee flip, before `return ok(updated)` inside withTx (atomic rollback semantics).
- [X] T009 Add `F4InvoicePaidEvent` type to F4 barrel `src/modules/invoicing/index.ts` (canonical shape per research.md R12) — file at `src/modules/invoicing/domain/f4-invoice-paid-event.ts`; barrel `export type` only. Fields: `tenantId, invoiceId, memberId, paidAt (ISO 8601 UTC), amountSatang (bigint), currency ('THB' literal)`. `paymentId` omitted from MVP shape — F8 listeners only need `invoiceId` to resolve linked cycle.
- [X] T010 Run F4 contract test green; merge F4 callback PR to main before continuing F8 work — 5/5 contract tests GREEN, 684/684 F4+F5 unit tests GREEN (zero regression), `pnpm typecheck` GREEN, `pnpm lint` GREEN. Solo-maintainer substitute (Constitution v1.4.0 § Governance): kept on `011-renewal-reminders` branch instead of separate PR; one Wave-A commit per plan commit strategy.

### F2 Scheduled-Plan-Change Coordinated Code PR (per Complexity Tracking #4)

- [ ] T011 Add F2 use-case `scheduleNextRenewalPlanChange` in `src/modules/plans/application/schedule-next-renewal-plan-change.ts`
- [ ] T012 Add F2 use-case `getEffectivePlanForRenewal(memberId, cycleId)` resolver in `src/modules/plans/application/get-effective-plan-for-renewal.ts`
- [ ] T013 Add F2 event-emit hook `member_plan_manually_changed` to F2's existing `changeMemberPlan` use-case
- [ ] T014 Extend F2 barrel `src/modules/plans/index.ts` with new exports
- [ ] T015 [P] Author F2 contract test at `tests/contract/f2-scheduled-plan-change.contract.test.ts` — schedule + apply + supersede paths
- [ ] T016 Merge F2 schedule-plan-change code PR to main before continuing F8 work (table delivered by F8 PR migration 0086 below per F7 precedent)

### F8 Migrations (9 files 0086-0094; per F7 precedent F8 owns ALL migrations including F2 cross-module table)

- [ ] T017 [P] Author migration `drizzle/migrations/0086_f8_create_scheduled_plan_changes_table.sql` — F2 cross-module new table per Complexity Tracking #4 + research.md R13; PK `(tenant_id, scheduled_change_id)`; UNIQUE `(tenant_id, member_id, effective_at_cycle_id) WHERE status='pending'`; F2 owns the schema definition but F8 PR delivers
- [ ] T018 [P] Author migration `drizzle/migrations/0087_f8_create_renewal_cycles_table.sql` — `renewal_cycles` schema per data-model.md § 2.1 (includes `frozen_plan_price_thb`, `frozen_plan_term_months`, `frozen_plan_currency`, `entered_pending_at`, `linked_credit_note_id`); 7-state CHECK including `pending_admin_reactivation`
- [ ] T019 [P] Author migration `drizzle/migrations/0088_f8_create_renewal_reminder_events_table.sql` — `renewal_reminder_events` schema per § 2.2; idempotency unique index on `(cycle_id, step_id, year_in_cycle)`
- [ ] T020 [P] Author migration `drizzle/migrations/0089_f8_create_tenant_renewal_config_tables.sql` — `tenant_renewal_settings` (§ 2.3) + `tenant_renewal_schedule_policies` (§ 2.4) consolidated since both per-tenant config; 5-bucket fixtures seeded for SweCham
- [ ] T021 [P] Author migration `drizzle/migrations/0090_f8_create_at_risk_outreach_table.sql` — per § 2.5
- [ ] T022 [P] Author migration `drizzle/migrations/0091_f8_create_tier_upgrade_suggestions_table.sql` — per § 2.6 with extended status enum (`accepted_pending_apply`, `applied`, `superseded`)
- [ ] T023 [P] Author migration `drizzle/migrations/0092_f8_create_renewal_escalation_tasks_table.sql` — per § 2.7
- [ ] T024 [P] Author migration `drizzle/migrations/0093_f8_create_consumed_link_tokens_table.sql` — per § 2.8 (token replay primitive)
- [ ] T025 [P] Author migration `drizzle/migrations/0094_f8_extend_members_and_plans_columns.sql` — F3 9 new columns + F2 `renewal_tier_bucket` enum + 5-step backfill per data-model.md § 3
- [ ] T026 Apply RLS+FORCE policies on all 9 F8 tables in same migration files (per data-model.md § 5)
- [ ] T027 Add CREATE INDEX CONCURRENTLY post-migration scripts in `drizzle/post-migrations/` for indexes that should not block migration tx
- [ ] T028 Run `pnpm drizzle-kit generate` + `pnpm drizzle-kit migrate` against local DB; verify all 9 F8 tables (8 F8-owned + 1 F2-cross-module) exist + RLS+FORCE active
- [ ] T029 [P] Add F8 tables to `scripts/check-multi-tenant-ready.ts` (E18 round 1) — RLS+FORCE present + USING `app.current_tenant` + no NULL `tenant_id` rows

### Domain Layer (zero framework imports)

- [ ] T030 [P] Domain value object `tier-bucket.ts` in `src/modules/renewals/domain/value-objects/tier-bucket.ts` — 5-value enum
- [ ] T031 [P] Domain value object `cycle-status.ts` — 7-value enum + invariants
- [ ] T032 [P] Domain value object `risk-band.ts` — 4-value enum + threshold computation
- [ ] T033 [P] Domain value object `reminder-step.ts` — schedule policy step shape
- [ ] T034 [P] Domain entity `renewal-cycle.ts` in `src/modules/renewals/domain/renewal-cycle.ts` + spec.ts — state-machine invariants per data-model.md § 2.1
- [ ] T035 [P] Domain entity `tier-upgrade-suggestion.ts` + spec.ts — 6-status state-machine + invariants
- [ ] T036 [P] Domain entity `renewal-escalation-task.ts` + spec.ts — 3-status lifecycle
- [ ] T037 [P] Domain entity `renewal-link-token.ts` + spec.ts — payload type + invariants per research.md R1
- [ ] T038 [P] Domain entity `at-risk-score.ts` + property-based fast-check spec.ts — 8-factor formula + F6-readiness fallback per FR-029 + FR-029a
- [ ] T039 [P] Domain entity `tenant-renewal-settings.ts` + spec.ts
- [ ] T040 [P] Domain entity `tenant-renewal-schedule-policy.ts` + spec.ts — bucket→steps mapping

### Application Ports (interfaces only)

- [ ] T041 [P] Port `renewal-cycle-repo.ts` in `src/modules/renewals/application/ports/`
- [ ] T042 [P] Port `renewal-reminder-event-repo.ts`
- [ ] T043 [P] Port `tier-upgrade-suggestion-repo.ts`
- [ ] T044 [P] Port `renewal-escalation-task-repo.ts`
- [ ] T045 [P] Port `tenant-renewal-settings-repo.ts`
- [ ] T046 [P] Port `tenant-renewal-schedule-policy-repo.ts`
- [ ] T047 [P] Port `renewal-gateway.ts` — transactional email dispatch (uses F1+F4 transactional Resend)
- [ ] T048 [P] Port `renewal-link-token-signer.ts` + `renewal-link-token-verifier.ts` (HMAC + dual-key rotation per R16)
- [ ] T049 [P] Port `event-attendees-port.ts` — F6 readiness probe per R5 contract assertion
- [ ] T050 [P] Port `at-risk-scorer.ts`
- [ ] T051 [P] Port `renewal-audit-emitter.ts` — emits all 58 audit events per audit-port.md

### Cross-tenant Integration Test (Review-Gate Blocker per Constitution Principle I)

- [ ] T052 Author `tests/integration/renewals/tenant-isolation.test.ts` — 2-tenant seed + cross-tenant probe (SELECT/INSERT/UPDATE/DELETE bidirectional) + `renewal_cross_tenant_probe` audit assertion across **all 9 F8-owned tables** (8 F8 tables + 1 F2 cross-module `scheduled_plan_changes` delivered via F8 migration 0086 per F7 precedent — resolves /speckit.analyze finding D1)
- [ ] T053 Run T052 against live Neon `ap-southeast-1`; assert ZERO cross-tenant visibility — Review-Gate blocker

### Composition Root Scaffold

- [ ] T054 Wire F8 composition root in `src/lib/composition-root-renewals.ts` (or equivalent) — instantiate ports + adapters + register F4 onPaidCallbacks per research.md R12 wiring example
- [ ] T055 Verify Phase 2 checkpoint: `pnpm test src/modules/renewals/domain/` GREEN + `pnpm test:integration tests/integration/renewals/tenant-isolation.test.ts` GREEN + `pnpm typecheck` + `pnpm lint` GREEN

---

## Phase 3 — User Story 1: Renewal Pipeline Dashboard (P1)

**Story Goal**: Admin opens `/admin/renewals` and sees every member by renewal-due date, grouped + colour-coded by tier and urgency. Drill-down + send/resend reminder + mark-contacted actions.

**Independent Test**: Seed 30 members with mixed tiers + expiry dates spread across 120 days. Open `/admin/renewals` as admin. Verify dashboard renders <500ms p95, all 5 tier-bucket colours render, urgency labels (T-90/T-60/T-30/T-14/T-7/T-0/Grace) match date math, no cross-tenant member visible.

### Use-cases

- [ ] T056 [P] [US1] Use-case `load-pipeline.ts` + spec.ts — server-side pagination + DB-side urgency derivation per FR-046
- [ ] T057 [P] [US1] Use-case `load-cycle-detail.ts` + spec.ts — single cycle + reminder history + linked invoice
- [ ] T058 [P] [US1] Use-case `cancel-cycle.ts` + spec.ts — admin manual cancel with reason audit
- [ ] T059 [P] [US1] Use-case `mark-paid-offline.ts` + spec.ts — admin records out-of-band payment + atomic F4 invoice issue + mark-paid in same tx

### Infrastructure

- [ ] T060 [P] [US1] Drizzle adapter `drizzle-renewal-cycle-repo.ts` in `src/modules/renewals/infrastructure/drizzle/` — implements `RenewalCycleRepo` port
- [ ] T061 [P] [US1] F8 → F4 bridge `f4-invoice-bridge.ts` in `src/modules/renewals/infrastructure/ports-adapters/` — calls F4 `createMembershipInvoice` from barrel
- [ ] T062 [P] [US1] Audit emitter wiring for cycle-lifecycle events: `renewal_cycle_created`, `renewal_cycle_cancelled`, `renewal_cycle_completed_offline`

### API Routes

- [ ] T063 [US1] `GET /api/admin/renewals` route handler in `src/app/api/admin/renewals/route.ts` — pagination + filter per contracts/admin-renewals-api.md § 1
- [ ] T064 [US1] `GET /api/admin/renewals/[cycleId]` route handler — detail view
- [ ] T065 [US1] `POST /api/admin/renewals/[cycleId]/cancel` route handler — admin RBAC gate + cancel use-case
- [ ] T066 [US1] `POST /api/admin/renewals/[cycleId]/mark-paid-offline` route handler — admin RBAC gate + atomic invoice + mark-paid

### UI Components

- [ ] T067 [US1] Admin pipeline page `src/app/(staff)/admin/renewals/page.tsx` — TanStack Table v8 + tier filter + urgency tabs
- [ ] T068 [US1] Loading skeleton `src/app/(staff)/admin/renewals/loading.tsx` — shimmer per FR-046a
- [ ] T069 [US1] Empty state component `src/app/(staff)/admin/renewals/_components/empty-state.tsx` — copy per FR-046a (3 locales)
- [ ] T070 [US1] Pipeline table component `_components/pipeline-table.tsx` — server-side sortable rows + LEFT JOIN `linked_invoice_id` resolution per E14
- [ ] T071 [US1] Urgency bucket tabs `_components/urgency-bucket-tabs.tsx` — T-90/T-60/T-30/T-14/T-7/T-0/Grace/Lapsed
- [ ] T072 [US1] Lapsed tab `_components/lapsed-tab.tsx` — separate tab for `cycle.status='lapsed'` + reactivate CTA
- [ ] T073 [US1] Tier badge component `src/components/renewals/tier-badge.tsx` — 5-bucket visual + a11y label
- [ ] T074 [US1] Urgency pill component `src/components/renewals/urgency-pill.tsx` — colour-coded + screen-reader text

### Tests

- [ ] T075 [P] [US1] Integration test `tests/integration/renewals/load-pipeline.test.ts` — fixture seed + p95 <500ms @ 600 visible rows
- [ ] T076 [P] [US1] Integration test `tests/integration/renewals/cancel-cycle.test.ts` — cancel transitions + audit
- [ ] T077 [P] [US1] Integration test `tests/integration/renewals/mark-paid-offline.test.ts` — atomic F4 invoice issue + mark paid + cycle complete
- [ ] T078 [US1] E2E test `tests/e2e/renewal-pipeline-dashboard.spec.ts` — US1 AS1-AS5 (pipeline render + tier filter + Lapsed tab + cross-tenant probe + 5k-member perf)
- [ ] T079 [US1] i18n keys for pipeline UI (~30 keys × 3 locales = 90 entries) in `src/i18n/messages/{en,th,sv}.json`

### Phase 3 Exit Checkpoint

- [ ] T080 [US1] Phase 3 exit: `pnpm test:integration tests/integration/renewals/load-pipeline.test.ts cancel-cycle.test.ts mark-paid-offline.test.ts` GREEN + E2E `renewal-pipeline-dashboard.spec.ts` GREEN + `pnpm check:i18n` GREEN + p95 measured <500ms

---

## Phase 4 — User Story 2: Tier-Aware Smart Reminder Schedule (P1)

**Story Goal**: System dispatches scheduled renewal-reminder emails per tier-calibrated schedule, in member's preferred locale, with content tailored to plan/benefit summary/outstanding invoice. Daily cron evaluates every active member, sends only due reminders, idempotently.

**Independent Test**: Seed 4 members on different tiers (Thai-Alumni, Regular, Premium, Partnership) with `expires_at = today + 30 days`. Run reminder cron once. Verify only tiers with T-30 step receive email (in preferred locale), 2nd run dispatches ZERO additional emails (idempotency), audit `renewal_reminder_sent` for every dispatch.

### Schedule Policy Domain & Admin UI

- [ ] T081 [P] [US2] Use-case `load-schedule-policies.ts` — per tenant, 5 buckets
- [ ] T082 [P] [US2] Use-case `update-schedule-policy.ts` — admin edit + audit `renewal_schedule_policy_updated`
- [ ] T083 [P] [US2] Drizzle adapter `drizzle-tenant-renewal-schedule-policy-repo.ts`
- [ ] T084 [US2] `GET /api/admin/renewals/settings/schedules` route handler
- [ ] T085 [US2] `PUT /api/admin/renewals/settings/schedules/[tierBucket]` route handler — admin RBAC + zod validation of step shape
- [ ] T086 [US2] Admin schedule editor page `src/app/(staff)/admin/renewals/settings/schedules/page.tsx`
- [ ] T087 [US2] Schedule editor component `_components/schedule-editor.tsx` — 5 tabs (one per bucket); drag-reorder steps; save audit toast

### Reminder Dispatch Use-cases

- [ ] T088 [P] [US2] Use-case `dispatch-renewal-cycle.ts` + spec.ts — daily cron entry; idempotency guard per FR-011; multi-year cycle handling per FR-010 (year_in_cycle); skip-reasons per FR-012 (including `multi_year_non_final_year`, `outreach_in_progress`, `no_primary_contact`, `member_below_min_tenure_for_step`); retry budget per FR-010a; **NULL primary_contact_email graceful skip per FR-019a (M3 audit fix)** — does NOT crash cron; creates idempotent `manual_outreach_required` escalation task; emits `renewal_reminder_skipped {reason: 'no_primary_contact'}` audit
- [ ] T089 [P] [US2] Use-case `send-reminder-now.ts` + spec.ts — admin manual dispatch sharing same code path; `actor_user_id = admin_id`
- [ ] T090 [P] [US2] Use-case `detect-bounce-threshold.ts` + spec.ts — F1 webhook synchronous-call hook per R8 rev-2; thresholds 1 hard / 3 soft-in-cycle / 5 soft-30d per FR-012a
- [ ] T091 [P] [US2] Use-case `reset-email-unverified.ts` + spec.ts — F1 verification flow callback resets `members.email_unverified` + closes `manual_outreach_required` task
- [ ] T092 [P] [US2] Use-case `pause-reminders-after-outreach.ts` + spec.ts — 7-day pause per FR-033 (P5-r1)

### Email Templates (5 buckets × 5–7 steps × 3 locales)

- [ ] T093 [P] [US2] React Email template `renewal.t-30.thai-alumni.tsx` + EN/TH/SV i18n
- [ ] T094 [P] [US2] React Email template `renewal.t-30.start-up.tsx` + i18n
- [ ] T095 [P] [US2] React Email template `renewal.t-30.regular.tsx` + i18n
- [ ] T096 [P] [US2] React Email templates `renewal.t-90.premium.tsx` + `renewal.t-30.premium.tsx` + i18n
- [ ] T097 [P] [US2] React Email templates `renewal.t-120.partnership.tsx` + `renewal.t-90.partnership.tsx` + `renewal.t-30.partnership.tsx` + i18n
- [ ] T098 [P] [US2] React Email templates for T-14, T-7, T+0, T+7 across applicable buckets + i18n
- [ ] T099 [P] [US2] Dual-format date footer component for emails per FR-014 (BE + Gregorian for `th-TH` body + footer; footer-only for `en`/`sv`)
- [ ] T100 [P] [US2] Resend transactional gateway adapter `resend-transactional-renewal-gateway.ts` — uses F1+F4 client (NOT F7 Broadcasts) per FR-019; reuses F1 retry budget per R12 §F1 retry alignment

### F1 Webhook Integration (synchronous in-process call per R8 rev-2)

- [ ] T101 [US2] Extend F1 Resend webhook handler at `src/app/api/webhooks/resend/route.ts` (or equivalent) with 4-line addition: when `FEATURE_F8_RENEWALS=true` AND member_id resolved AND event is bounce, await F8's `detectBounceThreshold(ctx, memberId)` from F8 barrel
- [ ] T102 [US2] F1 verification handler extension: on `email_verification_succeeded`, call F8's `resetEmailUnverified` from barrel

### Cron Coordinator + Per-Tenant (per R14)

- [ ] T103 [US2] Coordinator route handler `src/app/api/cron/renewals/dispatch-coordinator/route.ts` — Bearer-auth + 401 audit `cron_bearer_auth_rejected` per R17 + Upstash rate-limit on 401s + iterate active tenants + parallel fetch to per-tenant endpoints + emit `cron_dispatch_orchestrated` audit (M4 audit-emit fix); zero-tenant edge case returns 200 with `tenants_enqueued: 0` per Edge Cases
- [ ] T104 [US2] Per-tenant route handler `src/app/api/cron/renewals/dispatch/[tenantId]/route.ts` — `runInTenant` bind + `pg_advisory_xact_lock(hashtextextended('renewals:dispatch:'||tenantId, 0))` + invoke `dispatch-renewal-cycle` use-case
- [ ] T105 [P] [US2] cron-job.org configuration entry for daily 06:00 Asia/Bangkok dispatch coordinator

### Audit Events

- [ ] T106 [P] [US2] Audit emitter wiring for reminder events: `renewal_reminder_sent`, `renewal_reminder_skipped`, `renewal_reminder_send_failed`, `renewal_reminder_send_failed_permanent`, `renewal_reminder_retried`, `renewal_reminder_deferred_read_only`, `renewal_skipped_no_joined_at`, `member_email_unverified_threshold_crossed`

### Send-Reminder-Now Admin Action

- [ ] T107 [US2] `POST /api/admin/renewals/[cycleId]/send-reminder-now` route handler — admin RBAC + rate-limit 30/5min + idempotency 409 with toast info per Edge Cases concurrent admin
- [ ] T108 [US2] Admin "Send reminder" button component in pipeline + toast feedback per FR-058

### Tests

- [ ] T109 [P] [US2] Integration test `tests/integration/renewals/dispatch-cron-idempotency.test.ts` — re-run cron 3× same day produces zero duplicates per FR-011
- [ ] T110 [P] [US2] Integration test `tests/integration/renewals/multi-year-cycle.test.ts` — 3-year Partnership cycle + email skips year 1+2; tasks fire annually per FR-010 + Q4 round 1
- [ ] T111 [P] [US2] Integration test `tests/integration/renewals/bounce-threshold.test.ts` — 1 hard bounce / 3 soft-in-cycle / 5 soft-30d trigger paths per FR-012a
- [ ] T112 [P] [US2] Integration test `tests/integration/renewals/reminder-pause-after-outreach.test.ts` — admin records outreach + cron skips emails 7d
- [ ] T113 [US2] E2E test `tests/e2e/tier-aware-reminder-cron.spec.ts` — US2 AS1-AS7
- [ ] T114 [US2] i18n keys for ~50 reminder template strings × 3 locales = 150 entries

### Phase 4 Exit Checkpoint

- [ ] T115 [US2] Phase 4 exit: integration tests T109-T112 GREEN + E2E `tier-aware-reminder-cron.spec.ts` GREEN + cron pass <60s @ 5k members measured + i18n parity 

---

## Phase 5 — User Story 3: Member Self-Service Renewal Flow (P2)

**Story Goal**: Member receives reminder → clicks "Renew now" → token-verified portal → reviews benefit summary + frozen plan price → confirms → F4 invoice + F5 payment → cycle completes auto-reactivate (or pending_admin_reactivation if blocked) → confirmation page.

**Independent Test**: Seed Regular-tier member at T-14. As member, click email link → portal → confirm → mock-pay via F5 test card. Verify F4 invoice at frozen price, cycle status `completed`, `expires_at` advanced 1y, audit chain emitted, receipt PDF delivered. Test lapsed-member auto-reactivate path AND admin-blocked path AND timeout path.

### Renewal-Link Token Infrastructure

- [ ] T116 [P] [US3] HMAC signer `src/modules/renewals/infrastructure/tokens/hmac-renewal-link-signer.ts` per R1 + R16 dual-key
- [ ] T117 [P] [US3] HMAC verifier `hmac-renewal-link-verifier.ts` — 9-step verification per R1 v2 (subdomain check + member-tenant ownership)
- [ ] T118 [P] [US3] `peekTokenTenantId(token)` helper for pre-tenant bypass at public route entry
- [ ] T119 [P] [US3] Drizzle adapter `drizzle-consumed-link-tokens-repo.ts`
- [ ] T120 [P] [US3] Use-case `verify-renewal-link-token.ts` + spec.ts — generic-error response for all 6 failure modes per FR-027 (`malformed`, `mac_mismatch`, `expired`, `replay`, `cross_tenant`, `member_not_found_in_tenant`); 9-step verification per research.md R1 v2 using F1's `resolveTenantFromRequest()` abstraction (era-agnostic per M4 round-2 critique fix); emits `renewal_token_clicked_on_completed_cycle` audit if token verifies on already-completed cycle (M4 audit-emit fix per Edge Case Token re-issuance)

### Renewal Page + Confirm Flow

- [ ] T121 [P] [US3] Use-case `load-renewal-summary.ts` — frozen plan price display per FR-021 + FR-021a + benefit consumption summary (fall back 0/N if upstream module no data yet)
- [ ] T122 [P] [US3] Use-case `confirm-renewal.ts` + spec.ts — 100% branch coverage; FR-022 + FR-023 + FR-024 + FR-025; F4 createMembershipInvoice via barrel + F5 redirect; plan-change branch updates frozen price atomically per FR-021b
- [ ] T123 [P] [US3] Use-case `mark-cycle-complete-from-invoice-paid.ts` — F4 onPaidCallback per R12 LOCKED Option A; advances `expires_at`, transitions cycle to `completed`, cancels remaining reminders, dispatches welcome email — all in F4's tx per FR-023 atomic; respects FR-005b auto-reactivate vs admin-block branch
- [ ] T124 [P] [US3] Use-case `opt-out-renewal-reminders.ts` + `opt-in-renewal-reminders.ts` per FR-016
- [ ] T125 [US3] Public renewal page route `src/app/(member)/portal/renewal/[memberId]/page.tsx` — server-rendered; token verify entry via query param OR session-only entry. **Kill-switch guard (H1 audit fix)**: when `FEATURE_F8_RENEWALS=false`, return generic "Feature unavailable" page per FR-052(c) without leaking F8-specific messaging; emit audit `renewal_kill_switch_blocked` with `{route: '/portal/renewal/[memberId]'}` (NULL actor for public-route entry without verified token; resolved member from session if signed in). **Cross-member guard (H2 audit fix)**: if session member_id ≠ URL `[memberId]` (and no valid renewal-link token in query param), return 404 generic + emit audit `renewal_cross_member_probe` with `{actor_member_id, attempted_member_id}` per FR-027 invariant (mirror confirm-renewal POST guard at T130)
- [ ] T126 [US3] Loading skeleton `loading.tsx` + first-time-renewer onboarding banner per US3 AS1
- [ ] T127 [US3] Benefit summary component `_components/benefit-summary.tsx` — consumption bars from F2/F4/F6/F7 with fallback
- [ ] T128 [US3] Plan change selector `_components/plan-change-selector.tsx` — calls F2 plan-list barrel
- [ ] T129 [US3] Confirm renewal button + CTA hierarchy per FR-058
- [ ] T130 [US3] `POST /api/portal/renewal/[memberId]/confirm` route handler — rate-limit 10/1h + idempotent
- [ ] T131 [US3] Success page `src/app/(member)/portal/renewal/[memberId]/success/page.tsx` — new expires_at + receipt download link
- [ ] T132 [US3] Member preferences page `src/app/(member)/portal/preferences/renewals/page.tsx` + `POST /api/portal/preferences/renewals` route

### Lapsed-Portal Scope Middleware (FR-005a)

- [ ] T133 [US3] Cross-cutting middleware `src/middleware.ts` (NEW file) — `enforce-lapsed-portal-scope` intercepting ALL portal-prefixed API requests + 403 audit `lapsed_member_action_blocked` per FR-005a
- [ ] T134 [US3] Allowed-routes whitelist enumeration constant per FR-005

### Auto-Reactivation Flow + Pending State + Refund (FR-005b/c/d)

- [ ] T135 [P] [US3] Use-case `block-auto-reactivation.ts` + `unblock-auto-reactivation.ts` — admin RBAC + audit
- [ ] T136 [P] [US3] Use-case `admin-reactivate-lapsed-cycle.ts` — pending_admin_reactivation → completed + audit `lapsed_member_admin_reactivated`
- [ ] T137 [P] [US3] Use-case `admin-reject-reactivation.ts` — pending → cancelled + F5 refund per FR-005d + F4 credit-note + audit `lapsed_member_admin_reactivation_rejected`
- [ ] T138 [P] [US3] Use-case `reconcile-pending-reactivations.ts` — daily cron per FR-005c; T-7/T-3/T-1 reminder ladder + 30d auto-timeout + refund + emit 4 audit events (M4 audit-emit fix): `lapsed_member_admin_reactivation_reminder_t-7`, `lapsed_member_admin_reactivation_reminder_t-3`, `lapsed_member_admin_reactivation_reminder_t-1`, `lapsed_member_admin_reactivation_timed_out`
- [ ] T139 [US3] Coordinator route `src/app/api/cron/renewals/reconcile-pending-reactivations-coordinator/route.ts`
- [ ] T140 [US3] Per-tenant route `src/app/api/cron/renewals/reconcile-pending-reactivations/[tenantId]/route.ts`
- [ ] T141 [US3] cron-job.org configuration entry for daily 07:00 Asia/Bangkok
- [ ] T142 [US3] `POST /api/admin/members/[memberId]/block-auto-reactivation` + `unblock-auto-reactivation` route handlers
- [ ] T143 [US3] F5 admin-triggered refund pre-condition verification — confirm F5 barrel exposes `issueRefund(invoiceId, reason)`; if missing, escalate per FR-005d footnote

### Tests

- [ ] T144 [P] [US3] Integration test `tests/integration/renewals/renewal-link-token.test.ts` — 6 failure paths + happy path + replay + cross-tenant + member-not-found-in-tenant per R1 v2
- [ ] T145 [P] [US3] Integration test `tests/integration/renewals/self-service-renewal-tx.test.ts` — full atomic chain F5 → F4 onPaidCallback → F8 cycle complete + receipt email
- [ ] T146 [P] [US3] Integration test `tests/integration/renewals/lapsed-portal-scope.test.ts` — 4 allowed routes + 6 blocked routes + middleware intercept across F3/F6/F7 portal APIs
- [ ] T147 [P] [US3] Integration test `tests/integration/renewals/auto-reactivation-flow.test.ts` — auto path (default) + blocked-path (pending_admin_reactivation) + admin-approve + admin-reject-with-refund
- [ ] T148 [P] [US3] Integration test `tests/integration/renewals/pending-reactivation-timeout.test.ts` — T-7/T-3/T-1 reminder ladder + 30d auto-cancel + refund per FR-005c
- [ ] T149 [P] [US3] Integration test `tests/integration/renewals/frozen-price.test.ts` — F2 plan price changes mid-cycle do NOT affect open cycle; plan-change-mid-flow updates frozen value atomically per FR-021b
- [ ] T150 [US3] E2E test `tests/e2e/member-self-service-renewal.spec.ts` — US3 AS1-AS7
- [ ] T151 [US3] E2E test `tests/e2e/lapsed-portal-scope.spec.ts` — FR-005 allowed/blocked routes
- [ ] T152 [US3] i18n keys for renewal page + preferences page + auto-reactivation copy (~40 keys × 3 = 120 entries)

### Phase 5 Exit Checkpoint

- [ ] T153 [US3] Phase 5 exit: integration tests T144-T149 GREEN + E2E specs GREEN + frozen-price flow verified end-to-end + auto-reactivation 4 branches GREEN

---

## Phase 6 — User Story 4: At-Risk Member Detection (P2)

**Story Goal**: Weekly cron recomputes 0–100 risk score per member from 8 factors. Admin sees "At-Risk Members" widget sorted by score, can Contact (creates outreach) or Snooze (suppresses N days). F6-readiness fallback active until F6 ships.

**Independent Test**: Seed 10 members with synthetic engagement profiles. Run at-risk cron. Verify score in [0, active_max] within 60s, factors weight correctly per FR-029, ≥50-score members appear in widget sorted DESC, snooze hides for N days then re-evaluates, manager-role can record outreach but admin-only for snooze/score actions, granular kill-switch `FEATURE_F8_AT_RISK_DISABLED` short-circuits ONLY at-risk surfaces.

### Use-cases

- [ ] T154 [P] [US4] Use-case `compute-at-risk-score.ts` + spec.ts (with property-based fast-check) — 8 factors per FR-029 + F6-readiness fallback per FR-029a + proportional bands per FR-030 + min-tenure skip per FR-035 + per-tenant fault isolation
- [ ] T155 [P] [US4] Use-case `snooze-at-risk-member.ts` + spec.ts — 7/30/90 day options + audit `at_risk_snoozed`
- [ ] T156 [P] [US4] Use-case `record-at-risk-outreach.ts` + spec.ts — admin OR manager (FR-033 manager exception) + audit `at_risk_outreach_recorded` + 7-day reminder pause cascade

### Infrastructure

- [ ] T157 [P] [US4] Drizzle adapter `drizzle-at-risk-outreach-repo.ts`
- [ ] T158 [P] [US4] F6 stub-port adapter `f6-event-attendees-port-stub.ts` — returns `isAvailable() === false`; throws if `count*` called per R5 contract assertion
- [ ] T158a [P] [US4] **(M2 audit fix)** Author F6 EventAttendeesPort contract test at `tests/contract/event-attendees-port.contract.test.ts` per research.md R5 contract assertion — assert input/output shape identical regardless of which adapter wired (stub today, F6 real impl when shipped); F8-owned + F6 PR MUST pass before F6 can ship
- [ ] T159 [P] [US4] CTE-based at-risk-recompute query optimisation per E12 — single SQL CTE pre-joins F4+F6+F7 aggregates per member; perf test before SLO claim per memory `feedback_verify_cp_before_mark`

### Cron + Routes

- [ ] T160 [US4] Coordinator route `src/app/api/cron/renewals/at-risk-recompute-coordinator/route.ts` — weekly Sunday 02:00 Bangkok
- [ ] T161 [US4] Per-tenant route `src/app/api/cron/renewals/at-risk-recompute/[tenantId]/route.ts` — `runInTenant` + advisory lock + recompute
- [ ] T162 [US4] cron-job.org configuration entry for weekly recompute coordinator
- [ ] T163 [US4] `GET /api/admin/renewals/at-risk` route handler — band filter + cursor pagination per contracts/admin-renewals-api.md § 3
- [ ] T164 [US4] `POST /api/admin/renewals/at-risk/[memberId]/snooze` route handler — admin RBAC + 60/5min rate-limit
- [ ] T165 [US4] `POST /api/admin/renewals/at-risk/[memberId]/outreach` route handler — admin OR manager RBAC + 60/5min rate-limit (manager exception per FR-052a)

### Granular Kill-Switch

- [ ] T166 [US4] `FEATURE_F8_AT_RISK_DISABLED` env var integration per FR-052b — short-circuit at-risk widget routes + cron handlers + score-column reads return null

### UI

- [ ] T167 [US4] At-risk widget component `src/app/(staff)/admin/renewals/_components/at-risk-widget.tsx` — sorted-by-score table; Contact + Snooze CTAs hidden for `member` role + manager Snooze hidden + manager Contact visible
- [ ] T168 [US4] Risk score badge component `src/components/renewals/risk-score-badge.tsx` — band colour + screen-reader text + no colour-only signalling
- [ ] T169 [US4] Snooze duration picker dialog
- [ ] T170 [US4] Outreach record dialog with channel + template + outcome note

### Audit Events

- [ ] T171 [P] [US4] Audit emitter wiring: `at_risk_score_recomputed`, `at_risk_score_threshold_crossed`, `at_risk_snoozed`, `at_risk_outreach_recorded`, `at_risk_skipped_below_min_tenure`, `at_risk_compute_partial_failure`

### Tests

- [ ] T172 [P] [US4] Property-based test `src/modules/renewals/domain/at-risk-score.spec.ts` — fast-check 256 factor combinations × F6-active toggle = 512 cases per E15
- [ ] T173 [P] [US4] Integration test `tests/integration/renewals/at-risk-f6-fallback.test.ts` — F6 unavailable mode + F6 ships transition + bands shift correctly per FR-029a
- [ ] T174 [P] [US4] Integration test `tests/integration/renewals/at-risk-recompute-perf.test.ts` — 5k members + per-tenant <60s SLO measured + log result to `perf-benchmarks.md`
- [ ] T175 [P] [US4] Integration test `tests/integration/renewals/at-risk-snooze-outreach.test.ts` — snooze hides + auto-expires; manager records outreach allowed; manager snooze 403
- [ ] T176 [US4] E2E test `tests/e2e/at-risk-widget.spec.ts` — US4 AS1-AS6
- [ ] T177 [US4] i18n keys for widget UI + outreach templates + score-band labels (~25 keys × 3 = 75 entries)

### Phase 6 Exit Checkpoint

- [ ] T178 [US4] Phase 6 exit: property test 512 cases GREEN + integration tests T173-T175 GREEN + E2E GREEN + p95 recompute <60s @ 5k measured

---

## Phase 7 — User Story 5: Auto Tier-Upgrade Suggestions (P3)

**Story Goal**: Weekly cron evaluates each active member's declared turnover + 12-month invoice volume against next-higher tier eligibility. Surfaces suggestions in admin queue. Admin Accept → pending state + member email + T-180 verify task + apply at next renewal. Dismiss → suppress 90d. Reconcile orphaned pending applications.

**Independent Test**: Seed Regular-tier member with `declared_turnover_thb: 120_000_000` (above Premium 100M threshold). Run upgrade cron. Verify suggestion created, admin Accept transitions to `accepted_pending_apply` + member email + T-180 task created (if expires_at > 180d). Verify F4 renewal-invoice creation reads pending suggestion + applies upgraded plan price. Verify F2 manual plan change mid-pending → suggestion supersedes.

### Use-cases

- [ ] T179 [P] [US5] Use-case `evaluate-tier-upgrade.ts` + spec.ts — F2 eligibility threshold check + suppression check + auto-resolved branch + tenant-disabled branch
- [ ] T180 [P] [US5] Use-case `accept-tier-upgrade.ts` + spec.ts — 100% branch coverage; pending state insert + member email dispatch + T-180 task creation per FR-039 R7
- [ ] T181 [P] [US5] Use-case `dismiss-tier-upgrade.ts` + spec.ts — `suppressed_until: today + 90d`
- [ ] T182 [P] [US5] Use-case `escalate-tier-upgrade.ts` + spec.ts — drafts pre-filled outreach email + creates outreach record
- [ ] T183 [P] [US5] Use-case `apply-pending-tier-upgrade.ts` + spec.ts — F4 renewal-invoice-creation hook reads pending suggestion + calls F2 `getEffectivePlanForRenewal` + atomic plan price + audit `tier_upgrade_applied_at_renewal`
- [ ] T184 [P] [US5] Use-case `supersede-pending-tier-upgrade.ts` + spec.ts — listens for F2 `member_plan_manually_changed` event + transitions to `superseded`
- [ ] T185 [P] [US5] Use-case `reconcile-pending-applications.ts` + spec.ts — weekly cron per E19; detects orphaned pending suggestions + emits `tier_upgrade_pending_orphan_detected`

### Infrastructure

- [ ] T186 [P] [US5] Drizzle adapter `drizzle-tier-upgrade-suggestion-repo.ts`
- [ ] T187 [P] [US5] F8 → F2 bridge `f2-plan-change-bridge.ts` — calls `scheduleNextRenewalPlanChange` from F2 barrel
- [ ] T188 [P] [US5] F2 event listener registration — subscribe to `member_plan_manually_changed` for supersede flow
- [ ] T188a [P] [US5] **(G1 audit fix)** Use-case `reschedule-on-plan-change.ts` + spec.ts in `src/modules/renewals/application/` — F2 `member_plan_manually_changed` event listener (separate concern from supersede flow); for the affected member's active `RenewalCycle`: (1) compute new tier-bucket from new plan via F2 `getPlanBucket(planId)`, (2) enumerate not-yet-fired schedule steps under OLD tier-bucket policy, (3) enumerate steps under NEW tier-bucket policy, (4) compute diff (cancelled vs new step_ids), (5) emit audit `renewal_schedule_rescheduled` with `{member_id, cycle_id, old_tier_bucket, new_tier_bucket, cancelled_step_ids, new_step_ids}` per audit-port.md payload schema. **Idempotent**: re-firing event with same old_tier_bucket→new_tier_bucket emits ZERO duplicate audit (guarded by hash of last-recorded tier-bucket); **already-sent reminders NOT recalled** per spec.md Edge Cases line 182. F2 event listener registration in T188 wires this use-case alongside supersede-pending-tier-upgrade — both run in parallel on the same event

### Cron + Routes

- [ ] T189 [US5] Coordinator route `src/app/api/cron/renewals/tier-upgrade-evaluate-coordinator/route.ts` — weekly Sunday 03:00 Bangkok
- [ ] T190 [US5] Per-tenant route `src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts`
- [ ] T191 [US5] Coordinator route `src/app/api/cron/renewals/reconcile-pending-applications/route.ts` — weekly Saturday 05:00 (housekeeping)
- [ ] T192 [US5] cron-job.org configuration entries for evaluate + reconcile
- [ ] T193 [US5] `GET /api/admin/renewals/tier-upgrades` route handler — open + pending suggestions
- [ ] T194 [US5] `POST /api/admin/renewals/tier-upgrades/[suggestionId]/accept` route handler — admin RBAC + accept use-case
- [ ] T195 [US5] `POST .../dismiss` route handler — admin RBAC + dismiss use-case
- [ ] T196 [US5] `POST .../escalate` route handler — admin RBAC + escalate use-case

### UI

- [ ] T197 [US5] Tier-upgrade queue page section in `/admin/renewals` page tabs OR separate `/admin/renewals/tier-upgrades/page.tsx`
- [ ] T198 [US5] Tier-upgrade queue component `_components/tier-upgrade-queue.tsx` — TanStack Table + Accept/Dismiss/Escalate buttons + manager hidden CTAs
- [ ] T199 [US5] Accept confirmation dialog with summary of pending flow
- [ ] T200 [US5] Member transactional email template for "Your upgrade approved; effective at next renewal" + EN/TH/SV i18n

### Audit Events

- [ ] T201 [P] [US5] Audit emitter wiring: `tier_upgrade_suggested`, `tier_upgrade_accepted`, `tier_upgrade_pending_member_notified`, `tier_upgrade_pending_admin_verification_due`, `tier_upgrade_applied_at_renewal`, `tier_upgrade_pending_superseded_by_manual_change`, `tier_upgrade_pending_orphan_detected`, `tier_upgrade_dismissed`, `tier_upgrade_already_at_target`, `tier_upgrade_tenant_disabled`, `tier_upgrade_skipped_no_thresholds_configured`

### Tests

- [ ] T202 [P] [US5] Integration test `tests/integration/renewals/tier-upgrade-evaluate.test.ts` — eligibility branches + suppression + auto-resolved + tenant-disabled
- [ ] T203 [P] [US5] Integration test `tests/integration/renewals/tier-upgrade-pending.test.ts` — accept → pending → F4 hook applies; T-180 task created/skipped per cycle distance; manual override → superseded
- [ ] T204 [P] [US5] Integration test `tests/integration/renewals/tier-upgrade-reconcile.test.ts` — orphaned pending detection + audit emission
- [ ] T205 [US5] E2E test `tests/e2e/auto-tier-upgrade.spec.ts` — US5 AS1-AS6
- [ ] T206 [US5] i18n keys for queue UI + accept/dismiss/escalate copy + member notify email (~30 keys × 3 = 90 entries)

### Phase 7 Exit Checkpoint

- [ ] T207 [US5] Phase 7 exit: integration tests GREEN + E2E GREEN + cron pass <30s @ 5k measured + reconcile detects orphans correctly

---

## Phase 8 — User Story 6: Manual Escalation Task Queue (P3)

**Story Goal**: For tier-specific manual touchpoints (phone calls, in-person meetings, board escalation, T-180 verify-pending-tier-upgrade, T-30 manual-outreach-required, manual-admin-reactivation-review), system creates `RenewalEscalationTask` rows on appropriate offset day, surfaces in admin task queue, admin marks done/skipped/reassigns.

**Independent Test**: Seed Partnership-tier member with T-60 task. Verify task creation in queue with year-in-cycle pill (multi-year) + due_at + assigned_to_role. Mark Done with outcome note + audit. Mark Skipped (requires reason) + audit. Reassign + audit. Overdue >3d highlighted.

### Use-cases

- [ ] T208 [P] [US6] Use-case `create-escalation-task.ts` + spec.ts — idempotent insert per partial unique index `(member_id, cycle_id, task_type) WHERE status='open'`
- [ ] T209 [P] [US6] Use-case `complete-escalation-task.ts` + spec.ts — outcome note + audit `escalation_task_completed`
- [ ] T210 [P] [US6] Use-case `skip-escalation-task.ts` + spec.ts — required reason + audit `escalation_task_skipped`
- [ ] T211 [P] [US6] Use-case `reassign-escalation-task.ts` + spec.ts — change `assigned_to_user_id` + audit `escalation_task_reassigned`

### Infrastructure

- [ ] T212 [P] [US6] Drizzle adapter `drizzle-renewal-escalation-task-repo.ts` — partial unique index leverage
- [ ] T213 [P] [US6] Audit emitter wiring for task lifecycle events

### API Routes

- [ ] T214 [US6] `GET /api/admin/renewals/tasks` route handler — `assigned_to_user_id` filter (`me` | UUID | `unassigned`) + task_type filter + cursor
- [ ] T215 [US6] `POST /api/admin/renewals/tasks/[taskId]/done` — admin RBAC + outcome note
- [ ] T216 [US6] `POST .../skip` — admin RBAC + reason required (max 500)
- [ ] T217 [US6] `POST .../reassign` — admin RBAC + to_user_id

### UI

- [ ] T218 [US6] Admin task queue page `src/app/(staff)/admin/renewals/tasks/page.tsx`
- [ ] T219 [US6] Task queue component `_components/escalation-task-queue.tsx` — TanStack Table + per-user-tray filter + overdue >3d highlight + queue-top banner "X overdue"
- [ ] T220 [US6] Year-in-cycle pill component per FR-043 (multi-year cycle UX) — e.g., "Year 2 of 3 · Quarterly review · Fogmaker"
- [ ] T221 [US6] Done/skip dialogs with required reason capture
- [ ] T222 [US6] Reassign dropdown with admin user list

### Tests

- [ ] T223 [P] [US6] Integration test `tests/integration/renewals/escalation-task-lifecycle.test.ts` — done + skip + reassign transitions + audit
- [ ] T224 [P] [US6] Integration test `tests/integration/renewals/escalation-task-idempotency.test.ts` — open partial-unique enforcement
- [ ] T225 [US6] E2E test `tests/e2e/escalation-task-queue.spec.ts` — US6 AS1-AS4
- [ ] T226 [US6] i18n keys for queue UI + dialogs + year-in-cycle pill (~20 keys × 3 = 60 entries)

### Phase 8 Exit Checkpoint

- [ ] T227 [US6] Phase 8 exit: integration tests GREEN + E2E GREEN + queue UI overdue highlight visible + manual_outreach_required + manual_admin_reactivation_review + verify_pending_tier_upgrade tasks all flow correctly

---

## Phase 9 — Cross-cutting (RBAC enforcement + Observability + Audit emitter + Cross-tenant + i18n + a11y)

**Goal**: Wire every cross-cutting concern: RBAC matrix enforcement at use-case + UI layers, all 58 audit events emitted, 12+ OTel metrics + 5+ spans + 4+ alerts, pino redact paths, cross-tenant integration test (Review-Gate blocker), F3 archival cascade, READ_ONLY_MODE handling, FR-058 UX consistency, dual-format date footer (FR-014), reduced-motion + theme (FR-050a), bundle budgets, multi-tenant readiness GitHub workflow.

### RBAC Matrix Enforcement (FR-052a)

- [ ] T228 Use-case wrapper `enforce-rbac-on-f8-mutation.ts` + spec.ts — admin/manager/member role gate; 403 + audit `f8_role_violation_blocked`; manager exception for outreach record per FR-033 + FR-052a; admin-only for `block-auto-reactivation` per P2-r2
- [ ] T229 Apply RBAC wrapper at every F8 mutating route handler (manual sweep checklist)
- [ ] T230 [P] Integration test `tests/integration/renewals/rbac-defence-in-depth.test.ts` — manager attempts every mutating endpoint + 403 + audit; member attempts admin endpoint + 403; admin all-pass

### Observability (FR-054 + FR-055 + FR-056)

- [ ] T231 [P] OTel metrics wiring (12+ metrics): `renewals.cycles_active`, `renewals.cycles_in_grace`, `renewals.cycles_lapsed_total`, `renewals.reminders_sent_total{tier, offset_day}`, `renewals.reminders_skipped_total{reason}`, `renewals.reminders_failed_total{reason}`, `renewals.self_service_completed_total`, `renewals.self_service_failed_total`, `at_risk.scores_recomputed_total`, `at_risk.threshold_crossings_total{from_band, to_band}`, `tier_upgrade.suggestions_created_total`, `tier_upgrade.suggestions_accepted_total`
- [ ] T232 [P] OTel root spans (5+): `cron_renewal_dispatch`, `cron_at_risk_recompute`, `cron_tier_upgrade_evaluate`, `member_self_service_renewal`, `admin_pipeline_load`
- [ ] T233 [P] Alert rules (4+): cron-failure (no successful run in 25h), reminder-bounce-rate >5% over 24h, lapsed-without-reminder count >0, self-service drop-off >50%
- [ ] T234 [P] pino redact paths extension for F8 secrets + PII per FR-049: `member.email`, `member.primary_contact_email`, `renewal_token`, `renewal_link`, `RENEWAL_LINK_TOKEN_SECRET*`, `payment_method`, `card.*`
- [ ] T235 [P] Document SLO + alerts in `docs/observability.md` § 14 extension for F8

### Cross-tenant Integration Test (Review-Gate Blocker)

- [ ] T236 Verify cross-tenant test from T052 covers all 8 F8 tables + post-Phase-8 surfaces + emits `renewal_cross_tenant_probe` from both directions
- [ ] T237 Verify cross-member probe coverage (`renewal_cross_member_probe`) for portal renewal page

### F3 Archival/Erasure Cascade (FR-053)

- [ ] T238 [P] Use-case `cancel-in-flight-cycles-for-member.ts` — F3 archive cascade hook; cancels active cycles + tasks + suggestions + outreach (data retained per audit retention)
- [ ] T239 F3 cascade port registration `BroadcastsCascadePort`-style for F8 entities
- [ ] T240 [P] Integration test `tests/integration/renewals/f3-archival-cascade.test.ts`

### READ_ONLY_MODE Handling

- [ ] T241 Apply READ_ONLY_MODE skip path to all 6 cron handlers (return 503 + audit `renewal_reminder_deferred_read_only`)
- [ ] T242 Apply READ_ONLY_MODE 503 to all portal mutating actions + admin mutating endpoints
- [ ] T243 [P] Integration test `tests/integration/renewals/read-only-mode.test.ts`

### Cron-Secret Threat Model (R17 / CHK029 security)

- [ ] T244 Add Upstash rate-limit bucket for 401 responses on cron endpoints (10/5min per IP)
- [ ] T245 Audit emit `cron_bearer_auth_rejected` on every cron 401
- [ ] T246 Document secret rotation procedure for `CRON_SECRET` in `docs/runbooks/secret-rotation.md` AND extend with F8 `RENEWAL_LINK_TOKEN_SECRET` dual-key rotation procedure per research.md R16 (R3 audit fix)

### UX Consistency (FR-058 + FR-050a)

- [ ] T247 [P] Confirmation dialog component reused across destructive F8 actions per `docs/ux-standards.md` § 4
- [ ] T248 [P] Toast notification consistency wrapper for mutating actions per § 5
- [ ] T249 [P] `prefers-reduced-motion` audit + fallback for all F8 animations
- [ ] T250 [P] Theme support (light/dark/system) verified for all F8 surfaces via `next-themes`

### Dual-format Date Footer (FR-014)

- [ ] T251 Email layout component renders dual-format date for `th-TH` body + footer + Gregorian-primary footer for `en`/`sv`

### Concurrent Admin Action UX

- [ ] T252 Toast component for 409 idempotency-hit per Edge Cases — "Reminder already sent {timestamp} by {actor_name}"

### Multi-tenant Readiness Workflow

- [ ] T253 Add F8 tables to `scripts/check-multi-tenant-ready.ts` (RLS+FORCE present + USING `app.current_tenant` + no NULL `tenant_id`)
- [ ] T254 Update GitHub Actions workflow to include F8 in nightly multi-tenant readiness check

### Bundle & Performance Budgets

- [ ] T255 Add F8 surfaces to `pnpm check:bundle-budgets` script + document budgets in `perf-benchmarks.md`

### DPIA Stub + Processing Records

- [ ] T256 [P] Add DPIA stub for F8 PII processing in `docs/dpia.md` § F8
- [ ] T257 [P] Add F8 processing-records entry per PDPA + GDPR

### Audit Wiring Sweep

- [ ] T258 Verify all 58 audit events have emitter wiring + payload-schema test in `tests/contract/audit-port.contract.test.ts` (extends F7 pattern). **Explicit owner-task enumeration per audit event** (resolves /speckit.analyze finding C1) — generate `audit-event-coverage.md` matrix in `specs/011-renewal-reminders/` with the following structure:

  | Audit Event | Owner Task | Phase | Triggered by |
  |---|---|---|---|
  | `renewal_cycle_created` | T056 (load-pipeline + creation hook) | 3 | Cycle materialised on prev-cycle-paid OR first-time member |
  | `renewal_cycle_price_frozen` | T056 (cycle creation hook) | 3 | At cycle creation per FR-021a |
  | `renewal_cycle_cancelled` | T058 (cancel-cycle use-case) | 3 | Admin manual cancel |
  | `renewal_cycle_completed_offline` | T059 (mark-paid-offline use-case) | 3 | Admin offline payment record |
  | `renewal_lapsed` | T088 (dispatch use-case state-machine transition path) | 4 | grace_period_days exceeded without payment |
  | `renewal_reminder_sent` | T088 + T089 (dispatch + send-reminder-now) | 4 | Successful Resend dispatch |
  | `renewal_reminder_skipped` | T088 (dispatch use-case skip-reason branches) | 4 | Any of 8 skip reasons per FR-012 |
  | `renewal_reminder_send_failed` | T088 (dispatch use-case Resend error path) | 4 | Resend API error pre-retry |
  | `renewal_reminder_send_failed_permanent` | T088 (FR-010a 24h-exhaust path) | 4 | Retry budget exceeded |
  | `renewal_reminder_retried` | T088 (FR-010a retry attempt) | 4 | Each retry attempt |
  | `renewal_schedule_rescheduled` | **T188a** (reschedule-on-plan-change use-case — added per /speckit.analyze G1) | 7 | F2 `member_plan_manually_changed` listener cascade alongside supersede flow |
  | `renewal_schedule_policy_updated` | T082 (update-schedule-policy use-case) | 4 | Admin edit schedule UI |
  | `renewal_self_service_initiated` | T120 (verify-renewal-link-token success path) | 5 | Token verify success |
  | `renewal_invoice_created` | T122 (confirm-renewal use-case F4 invoice path) | 5 | F4 createMembershipInvoice success |
  | `renewal_with_plan_change` | T122 (FR-025 plan-change branch) | 5 | Member chose plan change at confirm |
  | `renewal_payment_failed` | T123 (mark-cycle-complete-from-invoice-paid F5 fail path) | 5 | F5 payment_failed event |
  | `renewal_completed` | T123 (mark-cycle-complete success path) | 5 | F4 invoice marked paid |
  | `renewal_completed_post_lapse` | T123 (auto-reactivate path per FR-005b) | 5 | Lapsed member completed payment |
  | `renewal_token_invalid` | T120 (verify use-case 6 failure modes) | 5 | Any verify failure mode |
  | `renewal_token_clicked_on_completed_cycle` | T120 (M4 audit fix path) | 5 | Token verifies on already-completed cycle |
  | `renewal_kill_switch_blocked` | T103 + cron handlers + portal route guards | 4-5 | `FEATURE_F8_RENEWALS=false` short-circuit |
  | `renewal_cross_tenant_probe` | T052 cross-tenant test fixture + middleware | 2 | Cross-tenant access attempt |
  | `renewal_cross_member_probe` | T130 (confirm-renewal cross-member 404 path) | 5 | Cross-member portal access |
  | `renewal_reminder_deferred_read_only` | T241 (READ_ONLY_MODE handler) | 9 | Cron skip during read-only mode |
  | `renewal_skipped_no_joined_at` | T088 (NULL joined_at edge case) | 4 | Member missing joined_at |
  | `lapsed_member_action_blocked` | T133 (lapsed-portal middleware) | 5 | Lapsed member hits blocked route |
  | `lapsed_member_admin_reactivated` | T136 (admin-reactivate use-case) | 5 | Admin approves pending reactivation |
  | `lapsed_member_admin_reactivation_rejected` | T137 (admin-reject use-case + refund) | 5 | Admin rejects pending reactivation |
  | `lapsed_member_admin_reactivation_timed_out` | T138 (reconcile-pending-reactivations 30d timeout) | 5 | Auto-cancel after 30d |
  | `lapsed_member_admin_reactivation_reminder_t-7` | T138 (reminder ladder day -7) | 5 | T-7 reminder email |
  | `lapsed_member_admin_reactivation_reminder_t-3` | T138 (reminder ladder day -3) | 5 | T-3 reminder email |
  | `lapsed_member_admin_reactivation_reminder_t-1` | T138 (reminder ladder day -1) | 5 | T-1 reminder email |
  | `member_auto_reactivation_blocked` | T135 (block-auto-reactivation use-case) | 5 | Admin sets blocked_from_auto_reactivation=TRUE |
  | `member_auto_reactivation_unblocked` | T135 (unblock-auto-reactivation use-case) | 5 | Admin clears flag |
  | `member_email_unverified_threshold_crossed` | T090 (detect-bounce-threshold use-case) | 4 | FR-012a threshold crossed |
  | `cron_dispatch_orchestrated` | T103 + T160 + T189 (3 coordinator endpoints) | 4-7 | Coordinator iterates tenants |
  | `cron_bearer_auth_rejected` | T245 (Upstash rate-limit + audit on 401) | 9 | Cron 401 response |
  | `at_risk_score_recomputed` | T154 (compute-at-risk-score use-case) | 6 | Per-member score write |
  | `at_risk_score_threshold_crossed` | T154 (band crossing branch) | 6 | Band ↑ to higher-risk |
  | `at_risk_snoozed` | T155 (snooze-at-risk use-case) | 6 | Admin snooze action |
  | `at_risk_outreach_recorded` | T156 (record-outreach use-case) | 6 | Admin/manager outreach |
  | `at_risk_skipped_below_min_tenure` | T154 (min-tenure skip branch) | 6 | Member <30d tenure |
  | `at_risk_compute_partial_failure` | T154 (per-tenant fault isolation) | 6 | Per-tenant error caught |
  | `tier_upgrade_suggested` | T179 (evaluate-tier-upgrade use-case) | 7 | Cron creates suggestion |
  | `tier_upgrade_accepted` | T180 (accept-tier-upgrade use-case) | 7 | Admin Accept action |
  | `tier_upgrade_pending_member_notified` | T180 (member email dispatch in accept flow) | 7 | Member email sent |
  | `tier_upgrade_pending_admin_verification_due` | T180 (T-180 task creation in accept flow) | 7 | Verify task created |
  | `tier_upgrade_applied_at_renewal` | T183 (apply-pending-tier-upgrade hook) | 7 | F4 renewal-invoice issued at upgraded plan |
  | `tier_upgrade_pending_superseded_by_manual_change` | T184 (supersede-pending use-case) | 7 | F2 manual override mid-pending |
  | `tier_upgrade_pending_orphan_detected` | T185 (reconcile-pending-applications cron) | 7 | Stale pending suggestion |
  | `tier_upgrade_dismissed` | T181 (dismiss-tier-upgrade use-case) | 7 | Admin Dismiss action |
  | `tier_upgrade_already_at_target` | T179 (cron skip branch) | 7 | Member already at suggested tier |
  | `tier_upgrade_tenant_disabled` | T179 (auto_upgrade_enabled=false branch) | 7 | Tenant opted out |
  | `tier_upgrade_skipped_no_thresholds_configured` | T179 (F2 metadata missing branch) | 7 | F2 plans lack eligibility data |
  | `escalation_task_created` | T208 (create-escalation-task use-case) | 8 | Cron OR admin creates task |
  | `escalation_task_completed` | T209 (complete-task use-case) | 8 | Admin marks done |
  | `escalation_task_skipped` | T210 (skip-task use-case) | 8 | Admin marks skipped |
  | `escalation_task_reassigned` | T211 (reassign-task use-case) | 8 | Admin reassigns |
  | `f8_role_violation_blocked` | T228 (RBAC wrapper) | 9 | Manager attempts admin-only mutation |

  T258 contract test verifies: every event in this matrix has owner-task creating audit; payload-schema TS type matches per audit-port.md; pino redact catches forbidden fields; ZERO orphan events (all 58 events accounted for).

### Additional Integration Tests (R1 audit fix — 5 missing tests)

- [ ] T258a [P] Integration test `tests/integration/renewals/cron-bearer-auth-rejected.test.ts` — missing/malformed/wrong Bearer per R17 + Upstash 429 on >10 attempts/5min/IP
- [ ] T258b [P] Integration test `tests/integration/renewals/kill-switch-granular.test.ts` — verify both `FEATURE_F8_RENEWALS=false` (full short-circuit covering: 6 cron handlers return 200 `{skipped:true}`, admin pipeline route returns 404 + audit, **portal renewal page returns generic 'feature unavailable' per FR-052(c) + audit `renewal_kill_switch_blocked`** per /speckit.analyze I1 audit fix, member self-service confirm endpoint returns 404 short-circuit) AND `FEATURE_F8_AT_RISK_DISABLED=true` (granular short-circuit ONLY at-risk surfaces: at-risk widget returns placeholder, at-risk recompute cron returns `{skipped:true,reason:'at_risk_disabled'}`, score-column reads return null; rest of F8 fully operational) per FR-052 + FR-052b
- [ ] T258c [P] Integration test `tests/integration/renewals/email-locale-fallback.test.ts` — TH missing key falls back to EN with dev warning; SV missing key falls back to EN; missing EN fails build per Constitution Principle V
- [ ] T258d [P] Integration test `tests/integration/renewals/f4-callback-rollback.test.ts` — F8 callback throws → F4 rolls back invoice mark-paid + cycle stays awaiting_payment + F5 webhook records failure for retry per research.md R12 Option A
- [ ] T258e [P] Integration test `tests/integration/renewals/concurrent-admin-send.test.ts` — two admins simultaneously click "Send reminder now" on same cycle → second returns 409 with idempotency-hit toast info per Edge Cases concurrent admin actions

### i18n Coverage Sweep

- [ ] T259 Run `pnpm check:i18n` GREEN — verify ~180 F8 keys × 3 locales = ~540 entries; no missing EN; TH/SV fallback to EN with CI-block on release branch

### Phase 9 Exit Checkpoint

- [ ] T260 Phase 9 exit: full audit-emit coverage + RBAC defence-in-depth + observability wired + cross-tenant test green + i18n parity + a11y passes axe-core E2E

---

## Phase 10 — Polish & Quality Gates

**Goal**: Perf benchmarks measured and documented (no SLO claims without measurement per project memory), full E2E pass + cross-browser, /speckit.review ≥3 rounds + /speckit.staff-review ≥2 rounds (solo-maintainer substitute per Constitution Principle IX), retrospective.

### Performance Benchmarks

- [ ] T261 Author + run pipeline-perf benchmark `tests/perf/pipeline-perf-bench.ts` — p95 < 500ms @ 5k members + 600 visible; document result in `perf-benchmarks.md`
- [ ] T262 Author + run cron-dispatch-perf benchmark — full pass < 60s @ 5k members per tenant; document
- [ ] T263 Author + run at-risk-recompute-perf benchmark — full pass < 60s @ 5k members per tenant; document
- [ ] T264 Author + run tier-upgrade-evaluate-perf benchmark — full pass < 30s @ 5k members per tenant; document
- [ ] T265 Author + run renewal-confirm-perf benchmark — TTFB < 600ms; confirm endpoint < 1.2s; document

### SC-004 Baseline Measurement (R11)

- [ ] T266 Query SweCham 2024-2025 admin records + compute pre-F8 renewal-rate baseline using formula from R11; document in `perf-benchmarks.md` § "F8 SC-004 pre-launch baseline"

### Accessibility & i18n Final Pass

- [ ] T267 Author E2E `tests/e2e/renewal-a11y.spec.ts` — axe-core scan on every F8 surface in BOTH light + dark themes + reduced-motion emulation
- [ ] T268 Author E2E `tests/e2e/renewal-i18n.spec.ts` — TH + EN + SV coverage on every F8 surface; Buddhist Era display rules verified
- [ ] T269 Manual screen-reader QA — VoiceOver / NVDA traversal of pipeline + at-risk widget + tier-upgrade queue + tasks + member portal renewal page (human-gated; results documented)

### Cross-browser

- [ ] T270 Cross-browser E2E pass on Chrome / Edge / Firefox / Safari latest 2 + Mobile Safari iOS 16+ + Chrome for Android 12+

### Manager Read-Only E2E Coverage

- [ ] T271 E2E `tests/e2e/manager-readonly.spec.ts` — manager sees all F8 surfaces; mutating CTAs absent; direct API POST returns 403 + audit `f8_role_violation_blocked`

### Solo-Maintainer Substitute Stack (Constitution Principle IX)

- [ ] T272 Run `/speckit.review` round 1 — capture findings + fixes (Constitution Principle IX § IX.5-stack #1 — ≥3 review passes)
- [ ] T273 Run `/speckit.review` round 2 — verify findings decreasing
- [ ] T274 Run `/speckit.review` round 3 — final low-severity-only pass
- [ ] T275 Run `/speckit.staff-review` round 1 (Principle IX § IX.5-stack #2 — correctness + security + tests triangulation via 3 independent agents)
- [ ] T276 Run `/speckit.staff-review` round 2 post-remediation (mandatory if any BLOCKER/CRITICAL in round 1)
- [ ] T277 Maintainer co-sign security checklist alongside staff-review-agent — Constitution Principle IX § IX.5-stack #5 post-remediation verification by fresh agent run + § IX.5-stack #3 coverage targets met (Domain 100% line + Application 80% line+branch + 100% branch on 11 security-critical use-cases) + § IX.5-stack #4 DB defence-in-depth (RLS+FORCE on all 9 tables + partial unique indexes + transactional state-machine constraints)

### Retrospective

- [ ] T278 Author retrospective document `specs/011-renewal-reminders/retrospective.md` — captures solo-maintainer substitute evidence + cumulative spec evolution (3 clarify rounds + 2 critique rounds + gap-resolution + checklist) + lessons learned + drift mitigations

### Final Verification

- [ ] T279 Full CI pipeline locally: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm check:bundle-budgets && pnpm test:integration && pnpm test:e2e --workers=1`
- [ ] T280 `pnpm audit --prod` — zero HIGH/CRITICAL vulns
- [ ] T281 `/speckit.verify` gate — verify implementation matches spec FR-by-FR
- [ ] T282 `/speckit.qa.run` — acceptance-criteria validation against running staging deployment
- [ ] T282a **(R2 audit fix)** Verify F4 callback PR merged on main + F2 schedule-plan-change code PR merged on main BEFORE F8 PR opens — query main branch git log for `[Spec Kit] F4 onPaidCallbacks` + `[Spec Kit] F2 scheduleNextRenewalPlanChange` commit messages; if either missing, BLOCKER on F8 PR
- [ ] T283 Update `CLAUDE.md` Active Technologies + Recent Changes with F8 ship summary
- [ ] T284 Update `docs/phases-plan.md` F8 status: REVIEW-READY → SHIPPED (after merge)

### Phase 10 Exit Checkpoint (= F8 PR Ready)

- [ ] T285 Phase 10 exit: all perf benchmarks measured + a11y/i18n/cross-browser E2E green + ≥3 review rounds + ≥2 staff-review rounds + retrospective written + CI green + maintainer co-sign + ready for `/speckit.ship` with `FEATURE_F8_RENEWALS=false` in production env (ships dark per A12 v3)

---

## Dependencies & User Story Order

```
Phase 1 (Setup)
   ↓
Phase 2 (Foundational — F4 PR + F2 PR + migrations + Domain + ports + cross-tenant test)
   ↓
   ├─→ Phase 3 (US1 P1) ──→ Phase 4 (US2 P1) ──┐
   │                                           │
   │   (US1 + US2 = MVP slice for renewal flow)│
   │                                           │
   ├─→ Phase 5 (US3 P2) ←──depends on Phase 4──┘
   │                       (US3 needs reminder cron + tokens)
   │
   ├─→ Phase 6 (US4 P2) — independent (only depends on Phase 2)
   │
   ├─→ Phase 7 (US5 P3) — depends on Phase 4 (cron pattern) + Phase 5 (F4 onPaidCallback)
   │
   └─→ Phase 8 (US6 P3) — depends on Phase 4 (task creation by reminder cron)
                          + Phase 5 (manual_admin_reactivation_review tasks)
                          + Phase 7 (verify_pending_tier_upgrade tasks)
   ↓
Phase 9 (Cross-cutting) — RBAC enforcement + observability + audit + i18n + a11y across ALL phases
   ↓
Phase 10 (Polish) — perf benchmarks + reviews + retrospective + ship-readiness
```

---

## Parallel Execution Examples

### Phase 2 — Foundational migrations (T018-T025) all `[P]` (8 different files)

```bash
# In parallel: 9 migrations
pnpm tsx scripts/scaffold-migration.ts 0086_f8_create_scheduled_plan_changes_table &
pnpm tsx scripts/scaffold-migration.ts 0087_f8_create_renewal_cycles_table &
pnpm tsx scripts/scaffold-migration.ts 0088_f8_create_renewal_reminder_events_table &
# ... etc through 0094
wait
```

### Phase 3 — US1 use-cases (T056-T059) all `[P]` (4 different files in `application/`)

### Phase 4 — Email templates (T093-T098) all `[P]` (separate files per bucket)

### Phase 6 — Property-based test + perf-bench (T172, T174) `[P]` (different files)

### Phase 9 — Observability wiring (T231-T234) all `[P]` (metrics, spans, alerts, redact paths in different files)

---

## Implementation Strategy

### MVP First (Phase 1-2 + Phase 3)

**MVP slice**: Setup + Foundational + US1 Pipeline Dashboard
**Demo value**: Admin can see all members + renewal status + manual mark-paid offline
**Tests required**: cross-tenant isolation (Review-Gate blocker) + pipeline integration tests + US1 E2E
**Estimated**: ~80 tasks (T001-T080); 2-3 weeks solo-dev
**Risk**: lowest — only US1 backend + UI shipped; no email/cron yet

### Renewal Engine Slice (Phase 4)

Adds: Tier-aware reminder cron + email templates + bounce detection + send-now admin
**Demo value**: System sends reminders automatically; admin can override
**Estimated additional**: ~35 tasks; 1-2 weeks
**Risk**: medium — touches F1 webhook + email reputation; full bounce-threshold testing required

### Self-Service Slice (Phase 5)

Adds: Member portal renewal flow + token verifier + auto-reactivation + lapsed-portal middleware + refund flow
**Demo value**: Member completes full renewal cycle without admin intervention
**Estimated additional**: ~38 tasks; 2 weeks
**Risk**: medium-high — depends on F4 callback (Complexity #3) + F5 refund (verify pre-condition T143)

### At-Risk + Tier-Upgrade Slices (Phase 6 + 7)

Phase 6 first (independent + simpler); Phase 7 second (depends on F4 + F2 contracts)
**Demo value**: Admin gets weekly insights + revenue uplift candidates
**Estimated additional**: ~50 tasks; 2-3 weeks combined
**Risk**: medium — F2 schedule-plan-change (Complexity #4) is real coordination

### Manual Tasks Slice (Phase 8)

Adds: escalation task queue + UI for manual touchpoints
**Estimated additional**: ~20 tasks; 1 week
**Risk**: low — purely admin UI + simple state machine

### Cross-cutting + Polish (Phase 9 + 10)

**Estimated additional**: ~60 tasks; 2-3 weeks
**Risk**: medium — observability + perf benchmarks + 3 review rounds + 2 staff-review rounds

### Total estimated effort

**~290 tasks · ~12-20 weeks solo-dev** (point estimate ~13 weeks linear from F7 ship velocity 218 tasks ÷ ~10 weeks; F8 broader scope adds uncertainty band; range 12-20 reflects ±30% variance per R5 audit fix). Cross-module coordination overhead (F4 + F2 PR sequencing) adds 1-2 weeks at upper bound; smooth-execution reduces 1-2 weeks at lower bound.

Solo maintainer should phase the implementation into demonstrable slices for stakeholder visibility (chamber director sees pipeline + reminders working before at-risk + tier-upgrade ship). Each slice ends with green test checkpoint + can be PR'd to main before next slice starts (within F8 branch).

---

## Format Validation Summary

✅ All tasks follow `- [ ] T### [P?] [Story?] Description with file path` format
✅ Phase 1 + 2 + 9 + 10 tasks have NO story label (correct — setup/foundational/cross-cutting/polish)
✅ Phase 3-8 tasks all have `[US1]`-`[US6]` story labels (correct — user-story phases)
✅ `[P]` markers applied to tasks in different files with no inter-task dependencies
✅ Every implementation task has explicit file path
✅ Sequential T### IDs through entire document
✅ Each phase has Goal + Independent Test + Exit Checkpoint
✅ Dependency graph shows F4 PR + F2 PR prereqs + cross-story dependencies

---

## Next Command

```
/speckit.analyze
```

Pre-implementation analysis gate. Runs static-checks against tasks.md + plan.md + spec.md to surface inconsistencies before /speckit.implement starts. After /speckit.analyze passes:

```
/speckit.implement
```

To execute tasks T001..T285 in order (with [P] tasks parallelisable within their phase).
