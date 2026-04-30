---

description: "F7 — Email Broadcast (E-Blast) — TDD-ordered task list"
---

# Tasks: F7 — Email Broadcast (E-Blast)

**Input**: Design documents from `/specs/010-email-broadcast/`
**Branch**: `010-email-broadcast`
**Prerequisites**: spec.md ✅ (19 clarifications · 6 user stories · 11 SCs · 42 FRs) · plan.md ✅ (Constitution Check GREEN · 4 deep-dives) · research.md ✅ · data-model.md ✅ (4 tables · 8 migrations) · contracts/ ✅ (3 contracts) · quickstart.md ✅ · 6 checklists ✅ (privacy/security/ux/a11y/i18n/perf — all 0 gaps)

**Tests**: TDD discipline NON-NEGOTIABLE per Constitution Principle II. Tests are authored RED **before** implementation per phase. Coverage: Domain 100% line · Application ≥80% line/branch · 100% branch on security-critical paths.

**Organization**: Tasks grouped by user story (US1–US6) so each can be implemented + tested + delivered as an MVP increment. **MVP slice = Setup + Foundational + US1 + US2** (compose+submit + admin review). US3–US6 layered incrementally.

**Total**: **224 tasks** (218 original + 4 added Round 1 post-/speckit.analyze: T125a SLA banner / T152a transactional-broadcast separation test / T171a draft-expiry cron / T178a member-erasure auto-cancel cascade; +2 added Round 2 post-/speckit.analyze re-verify: T018a actor_role enum migration / T125a-test SLA contract test).

## Format: `[ID] [P?] [Story?] Description with file path`

- **[P]**: Parallelisable (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label (US1–US6); absent on Setup / Foundational / Polish
- All paths absolute from repo root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Package installation, env vars, config plumbing. No business logic yet.

- [X] T001 Add new dependencies to `package.json`: `@tiptap/react@^3` `@tiptap/starter-kit@^3` `isomorphic-dompurify@^2` `email-validator@^2` `@tanstack/react-virtual@^3` (CHK039 virtualization). Run `pnpm install` and commit `pnpm-lock.yaml`.
- [X] T002 [P] Pin exact versions of `@tiptap/react`, `@tiptap/starter-kit`, `isomorphic-dompurify` in `package.json` (sanitiser is security-critical per Plan § Constitution OWASP A06; version bumps require extra reviewer scrutiny). Resolved versions: `@tiptap/react@3.22.5`, `@tiptap/starter-kit@3.22.5`, `isomorphic-dompurify@2.36.0`.
- [X] T003 [P] Extend `src/lib/env.ts` zod schema: add `RESEND_BROADCASTS_API_KEY` (re_-prefix, min 10) · `RESEND_BROADCASTS_WEBHOOK_SECRET` (string min 32) · `UNSUBSCRIBE_TOKEN_SECRET` (string min 32 — distinct from `AUTH_COOKIE_SIGNING_SECRET` per research.md § 4) · `FEATURE_F7_BROADCASTS` (boolean default `false`). **Deviation per user decision 2026-04-29**: skip `src/lib/env.example.ts` mirror — file doesn't exist in F1–F5; inline doc comments are the canonical project convention.
- [X] T004 [P] Add `RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET`, `FEATURE_F7_BROADCASTS` to `vercel env add` for `development`, `preview`, `production` (run via Vercel CLI, NOT committed). **User-driven manual step — out of scope for code edits.**
- [X] T005 [P] **Deviation per user decision 2026-04-29**: skip `vercel.json` cron entry (JSON has no comments + Hobby plan 1×/day rate-limit incompatible with 5-min cadence — would silently rate-limit or activate unwantedly on future Pro upgrade). Authored `docs/runbooks/cron-jobs.md` only — comprehensive index runbook covering F5 `stale-pending-count` + F7 `broadcasts/dispatch-scheduled`, with cron-job.org setup steps, Bearer-auth (CRON_SECRET shared from F4/F5), secret-rotation procedure, and Pro-plan migration path.
- [X] T006 [P] Pin Sarabun TTF fonts already inherited from F4 — NO new font assets for F7 (Tiptap inherits via Tailwind tokens). Verified: `public/fonts/sarabun/Sarabun-{Regular,Medium,Bold}.ttf` present alongside OFL.txt + README.md.
- [X] T007 [P] Update `eslint.config.mjs` `no-restricted-imports` rule (5 edits): (A) extended `domainForbiddenImports` with `@tiptap/react`, `@tiptap/starter-kit`, `isomorphic-dompurify`, `email-validator`; (B) extended `applicationForbiddenImports` with same 4 deps; (C) extended Domain + Application subpath `group:` arrays with `@tiptap/*`; (D) added F7 cross-module barrel rule mirroring F5 payments pattern (lines 285–301 of eslint.config.mjs); (E) added `src/modules/broadcasts/**` to the cross-module barrel-rule `ignores` list so intra-module wiring keeps working.
- [X] T008 [P] Added `@next/bundle-analyzer@^16.2.4` devDep + `pnpm build:analyse` script (`ANALYZE=true next build --turbopack`). Per perf.md CHK038 bundle budgets (compose ≤180 KB gz / queue ≤120 KB gz / detail ≤100 KB gz / benefits ≤80 KB gz / unsubscribe ≤30 KB gz). `next.config.ts` `withBundleAnalyzer` wrapper deferred to Foundational/Per-story phase per Risks-section mitigation (Turbopack-vs-bundle-analyzer compatibility audit needed before wiring).
- [X] T009 Create empty bounded-context skeleton at `src/modules/broadcasts/{domain,application,infrastructure}/.gitkeep` and `src/modules/broadcasts/index.ts` (empty barrel — `export {};` populated incrementally by Foundational + per-story tasks).
- [X] T010 Update `CLAUDE.md` § Active Technologies — added Phase 1 Setup row noting all 5 prod deps + 1 devDep + 4 env vars + 5 ESLint edits + cron-jobs.md runbook + 2 documented deviations. Updated `Last updated:` line to today. Added Recent Changes entry summarising T001–T010 ship + Phase 1 checkpoint GREEN. (`update-agent-context.ps1` not invoked — manual edit is canonical here since the Active Technologies section is hand-curated, not auto-generated.)

**Checkpoint**: Setup ready — `pnpm typecheck` + `pnpm lint` pass with empty F7 module.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema migrations, RLS policies, kill-switch, port interfaces, tenant-context plumbing. **MUST complete before any user story.**

**⚠️ CRITICAL**: No user story work can begin until this phase is complete and integration tests for tenant-isolation + kill-switch are GREEN.

### 2.1 Database schema migrations (8 migrations)

- [X] T011 Create migration `drizzle/migrations/0064_create_broadcasts.sql` — defines `broadcasts` table per data-model.md § 1.1 with: composite PK `(tenant_id, broadcast_id)`, all 8 status enum values, all check constraints, 4 indexes, RLS+FORCE + tenant-isolation policy + 3 PL/pgSQL triggers (immutable-after-submit per Q3 + state-machine per FR-004a + updated_at touch). **Implemented 2026-04-29 Batch B**: hand-written (drizzle-kit auto-generate confused by stale meta snapshots — pivoted to F4/F5 hand-write convention); 3 enums (broadcast_status, broadcast_segment_type, broadcast_actor_role with 'system' value included from start consolidating T018a); chamber_app role grants (SELECT/INSERT/UPDATE/DELETE).
- [X] T012 [P] Create migration `drizzle/migrations/0065_create_broadcast_deliveries.sql` — `broadcast_deliveries` table per data-model.md § 1.2 with: composite PK `(tenant_id, delivery_id)`, `(tenant_id, resend_event_id) UNIQUE` index (FR-025 idempotency primitive), `(tenant_id, broadcast_id, status)` index, `(tenant_id, recipient_email_lower)` index. RLS+FORCE policy. **Implemented 2026-04-29 Batch B**: 1 enum (broadcast_delivery_status); append-only triggers (no_update + no_delete) per data-model § 4.4; chamber_app grants SELECT+INSERT only (no UPDATE/DELETE — append-only invariant at role level).
- [X] T013 [P] Create migration `drizzle/migrations/0066_create_marketing_unsubscribes.sql` — `marketing_unsubscribes` table per data-model.md § 1.3 with: PK `(tenant_id, email_lower)` (FR-018 tenant-scope invariant), reason enum, `member_id` nullable. RLS+FORCE policy. **Indefinite retention** per GDPR Art. 21 + PDPA §32. **Implemented 2026-04-29 Batch B**: 1 enum (marketing_unsubscribe_reason — 4 values); 2 indexes (member_lookup partial WHERE member_id IS NOT NULL + unsubscribed_at DESC for ops dashboard); chamber_app grants SELECT+INSERT+UPDATE (no DELETE — Art. 17 cascade uses UPDATE setting member_id=NULL).
- [X] T014 [P] Create migration `drizzle/migrations/0067_create_broadcast_segment_definitions.sql` — `broadcast_segment_definitions` per data-model.md § 1.4. RLS+FORCE policy. **Implemented 2026-04-29 Batch B**: composite PK + tenant_type index; reuses broadcast_segment_type enum from 0064; chamber_app grants SELECT+INSERT+UPDATE (DELETE not granted — F7.1 admin UI uses enabled=false for soft-disable).
- [X] T015 [P] Create migration `drizzle/migrations/0068_seed_default_segment_definitions.sql` — seeds 9 default segments for SweCham tenant. Idempotent via `WHERE NOT EXISTS` checks. **Implemented 2026-04-29 Batch B**: all_members + 6 tier presets (premium, large, regular, diamond, platinum, gold) + event_attendees_last_90d + custom; tenant hardcoded to 'swecham' (single-tenant deployment per F1; F7.1+ multi-tenant adds per-tenant seed flow); display_label_i18n_key references future Phase 5+ next-intl translation keys under `broadcasts.segment.*`.
- [X] T016 [P] Create migration `drizzle/migrations/0069_audit_log_extend_retention_default_trigger.sql` — extends F5's 0063 trigger to document F7 events default 5y retention. **Implemented 2026-04-29 Batch B**: `CREATE OR REPLACE FUNCTION audit_log_default_retention_for_f4_tax_docs()` with extended comment block enumerating all 37 F7 event types as deliberately falling through (no IN() promotion); F7 has no tax-doc overlap so trigger function logic unchanged from 0063. No backfill UPDATE — F7 events have not yet been emitted (Phase 3+ adapter not landed).
- [X] T017 [P] Create migration `drizzle/migrations/0070_alter_members_add_broadcasts_halted_until_admin_review.sql` — adds `members.broadcasts_halted_until_admin_review boolean NOT NULL DEFAULT false` (Q14 per-broadcast complaint-rate auto-halt) + partial index. **Implemented 2026-04-29 Batch B**: idempotent via `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`; F3 schema-members.ts updated in tandem (drizzle-kit aware of column ownership per R022 fix discipline).
- [X] T018 [P] Create migration `drizzle/migrations/0071_alter_members_add_broadcasts_acknowledged_at.sql` — adds `members.broadcasts_acknowledged_at timestamp with time zone` (Q15 GDPR Art. 7) + partial index. **Implemented 2026-04-29 Batch B**: nullable column; banner-eligible-members partial index `WHERE broadcasts_acknowledged_at IS NULL`; idempotent via `ADD COLUMN IF NOT EXISTS`.
- [X] T018a [P] **Consolidated into 0064** (deviation 2026-04-29 Batch B — recorded in plan.md § Complexity Tracking). The `'system'` enum value was included from the start in `broadcast_actor_role` CREATE TYPE in 0064; no separate ALTER TYPE migration needed. The originally-planned 0072 file is intentionally absent. Net migration count for Batch B: 8 files (0064–0071), not 9.
- [X] T019 Apply all 8 migrations (0064–0071) via `pnpm db:migrate` against staging Neon Singapore. **Implemented 2026-04-29 Batch B**: `pnpm db:migrate` exits 0; `_journal.json` extended with 8 entries (idx 64–71); RED foundational tests T021 + T022 turn GREEN post-apply (33 + 16 tests pass); T023 sanity test correctly RED with `ENOENT: kill-switch.ts not found` waiting for Batch D T031.

### 2.2 Drizzle schema + repos (Infrastructure layer skeleton)

- [X] T020 Create `src/modules/broadcasts/infrastructure/schema.ts` — Drizzle schema for all 4 F7 tables matching migrations 0064–0067 + 5 enum types (`broadcastStatusEnum`, `broadcastSegmentTypeEnum`, `broadcastActorRoleEnum`, `broadcastDeliveryStatusEnum`, `marketingUnsubscribeReasonEnum`). Inferred types live here only (Principle III — must NOT leak to Application/Domain). **Implemented 2026-04-29 Batch A**: 4 pgTable + 5 pgEnum + 8 inferred Row types (BroadcastRow/NewBroadcastRow × 4 tables); F4 array-syntax `(table) => [...]` for constraints; all 6 CHECK constraints (subject_length / body_html_size / custom_recipient_cap / estimated_recipient_cap / quota_year_only_on_sent / retention_years) + 4 indexes per table per data-model.md § 1.1–1.4 verbatim.
- [X] T021 [P] Create `tests/integration/rls-coverage.test.ts` extension verifying all 4 F7 tables have RLS+FORCE+policy. **Implemented 2026-04-29 Batch B**: extended `TENANT_SCOPED_TABLES` array with `broadcasts` + `broadcast_deliveries` + `marketing_unsubscribes` + `broadcast_segment_definitions`; existing `it.each(...)` blocks auto-pick up the 4 new strings. Initial state RED (tables didn't exist) → GREEN after T019 apply (33/33 tests pass).
- [X] T022 [P] Create RED foundational integration test `tests/integration/broadcasts/tenant-isolation.test.ts` — Constitution v1.4.0 Principle I clause 3 Review-Gate blocker. **Implemented 2026-04-29 Batch B**: 16 tests across 4 F7 tables; two test tenants (test-swecham-{uuid8} + test-chamber-{uuid8}); SELECT/UPDATE/DELETE/INSERT cross-tenant probes for broadcasts; SELECT/INSERT for broadcast_deliveries (UPDATE/DELETE blocked by append-only triggers — RLS pre-trigger still applies to SELECT); SELECT/UPDATE/INSERT for marketing_unsubscribes; SELECT/UPDATE for broadcast_segment_definitions. test-tenant.ts cleanup helper extended to include 4 F7 tables (DELETE order: deliveries with append-only trigger DISABLE/ENABLE wrap → broadcasts → suppressions + segment_defs in parallel). Initial state RED → GREEN after T019 apply (16/16 pass in 8.4s).
- [X] T023 [P] Create RED foundational integration test `tests/integration/broadcasts/kill-switch.test.ts` — covers 4 scenarios per Coverage Gap C3 from /speckit.analyze. **Implemented 2026-04-29 Batch B as TODO-RED skeleton** (Option A per user resolution): 11 `it.todo(...)` placeholders enumerating the 4 scenarios + 1 sanity test asserting `src/modules/broadcasts/infrastructure/kill-switch.ts` exists. Sanity test uses `fs.access` (Vitest vm sandbox doesn't support `new Function('m','return import(m)')` — surfaces as `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` which is the wrong RED reason). Initial state: 1 RED with `ENOENT: kill-switch.ts not found` (correct reason — Batch D T031 will land the helper) + 11 TODO. Full GREEN after Batch D T031 + Phase 3+ T073+ extend the TODOs into real assertions.

### 2.3 Domain skeleton + ports

- [X] T024 [P] Create Domain value objects in `src/modules/broadcasts/domain/value-objects/`:
  - `email-lower.ts` — branded type with lowercase + trim normalisation
  - `quota-counter.ts` — immutable VO `{used: number; reserved: number; remaining: number; cap: number}`
  - `broadcast-status.ts` — enum + transition map (per FR-004 happy path + side branches)
  - `segment-type.ts` — sum type (`'all_members' | 'tier' | 'event_attendees_last_90d' | 'custom'`)
  - `delivery-status.ts` — enum (`'sent' | 'delivered' | 'bounced' | 'soft_bounced' | 'complained'`)

  **Implemented 2026-04-29 Batch A**: 5 files; `EmailLower` branded type + `asEmailLower(raw): Result` factory with normalisation + `unsafeBrandEmailLower` for trusted contexts; `QuotaCounter` immutable VO + `asQuotaCounter` factory enforcing all 5 invariants (non-negative cap/used/reserved + over_subscription + integer); `BROADCAST_STATUSES` 8-tuple + `isTerminalStatus` helper; `BROADCAST_SEGMENT_TYPES` 4-tuple; `BROADCAST_DELIVERY_STATUSES` 5-tuple + `isSuppressionTriggering` helper.
- [X] T025 [P] Create Domain invariants in `src/modules/broadcasts/domain/invariants/`:
  - `quota-counter-non-negative.ts` — FR-008
  - `one-active-broadcast-state.ts` — state machine cannot be in two states simultaneously
  - `suppression-tenant-scoped.ts` — FR-018

  **Implemented 2026-04-29 Batch A**: 3 pure-function invariants returning `Result<true, InvariantError>`. `enforceQuotaCounterNonNegative` checks all 5 quota invariants; `enforceOneActiveBroadcastState` validates timestamp/status agreement across all 8 states (per-status field-nullability rule table); `enforceSuppressionTenantScoped` guards against cross-tenant suppression read leaks at Application boundary.
- [X] T026 [P] Create Domain policies in `src/modules/broadcasts/domain/policies/`:
  - `broadcast-status-transitions.ts` — FR-004 + FR-004a state machine enforcement
  - `cancel-cutoff-policy.ts` — Clarifications Q10 (cancel allowed in `submitted|approved` only)

  **Implemented 2026-04-29 Batch A**: `broadcast-status-transitions.ts` exports adjacency table `BROADCAST_TRANSITIONS` + `canTransition(from, to): boolean` + `transition(from, to): Result<BroadcastStatus, BroadcastTransitionError>` enforcing 8-state machine (terminal states have empty outbound arrays). `cancel-cutoff-policy.ts` exports `canCancel(status): boolean` (true only for submitted/approved) + `authorizeCancel(status): Result<true, CancelCutoffError>` for the `broadcast_cancel_too_late` audit code path.
- [X] T027 [P] Create Domain aggregates in `src/modules/broadcasts/domain/`:
  - `broadcast.ts` — aggregate root holding the state machine
  - `broadcast-delivery.ts` — aggregate
  - `marketing-unsubscribe.ts` — VO
  - `recipient-segment.ts` — policy + sum type

  **Implemented 2026-04-29 Batch A**: 4 pure-data interfaces (no class — F4/F5 convention). `Broadcast` aggregate with 33 readonly fields + `BroadcastId` branded UUID + `asBroadcastId`/`parseBroadcastId` constructors + `BroadcastActorRole` 3-value union (`member_self_service | admin_proxy | system`). `BroadcastDelivery` interface + `BroadcastDeliveryId` branded UUID + `BounceType` (`hard | soft`). `MarketingUnsubscribe` interface (composite PK `(tenantId, emailLower)` so no separate ID) + `MARKETING_UNSUBSCRIBE_REASONS` 4-tuple. `RecipientSegment` discriminated union (4 variants) + `BroadcastSegmentDefinition` interface + `BroadcastSegmentDefinitionId` branded UUID.
- [X] T028 [P] Create Application port interfaces in `src/modules/broadcasts/application/ports/`:
  - `broadcasts-repo.ts`
  - `broadcast-deliveries-repo.ts`
  - `marketing-unsubscribes-repo.ts`
  - `broadcast-segment-definitions-repo.ts`
  - `broadcasts-gateway-port.ts` (Resend Broadcasts SDK abstraction)
  - `webhook-verifier-port.ts` (signature verification)
  - `html-sanitizer-port.ts` (FR-002a contract)
  - `email-validator-port.ts` (FR-015d format check)
  - `members-bridge-port.ts` (F3 barrel — `getMembersBySegment`, `getMemberPrimaryContact`, `lookupContactEmailInTenant`, `lookupMemberPrimaryContactEmailInTenant`)
  - `plans-bridge-port.ts` (F2 barrel — `getPlanForMember`)
  - `event-attendees-repository.ts` (FR-015a stub-port for F6 swap)
  - `unsubscribe-token-port.ts` (HMAC sign + verify)
  - `audit-port.ts`
  - `clock-port.ts`
  - `rate-limiter-port.ts` (F1 Upstash)
  - `email-transactional-port.ts` (F1+F4 transactional Resend)

  **Implemented 2026-04-29 Batch A**: 16 port interface files (tasks.md says "15" but actual list above contains 16 — `audit-port` is the 16th). All ports follow F4/F5 conventions: discriminated `kind` errors for gateway+webhook+token paths; `Result<T, E>` for Application-layer fallible ops; `Promise<T | null>` for repository lookups; `TenantContext` first-parameter for cross-module bridge ports. **Audit port** carries 37 F7 event types as a const tuple with compile-time count assertion (`type _AssertF7AuditEventCount = (typeof F7_AUDIT_EVENT_TYPES)['length'] extends 37 ? true : never`); all events default to 5y retention via `F7_AUDIT_RETENTION_YEARS` map (no tax-document overlap; F7 is operational + marketing-consent). **Webhook verifier** uses Svix HMAC-SHA256 (Resend Broadcasts standard) with `WebhookSignatureError` discriminated `kind` (mirror of F5 Stripe pattern). **Members bridge port** has 7 methods: 4 read methods (FR-015c + FR-015d resolution branches) + 2 halt-flag methods (Q14 admin clear-halt + getMembersHaltedInTenant) + 1 acknowledgement method (Q15 GDPR Art. 7). **Plus public barrel** at `src/modules/broadcasts/index.ts` re-exports Domain branded types + VOs + policies + audit-event types only (Infrastructure schema + repos + ports remain hidden per Constitution Principle III).

### 2.4 F2 + F3 barrel extensions

- [X] T029 Extend `src/modules/members/index.ts` with 7 new public exports + supporting types. **Implemented 2026-04-30 Batch C**: 7 use-cases under `src/modules/members/application/use-cases/` (getMembersBySegment, getMemberPrimaryContact, lookupContactEmailInTenant, lookupMemberPrimaryContactEmailInTenant, getMembersHaltedInTenant, setMemberHalt, markBroadcastsAcknowledged). Extended `MemberRepo` interface with 6 new methods (`findMembersBySegmentForBroadcast`, `findMembersHaltedForBroadcast`, `updateBroadcastsHaltedInTx`, `updateBroadcastsAcknowledgedAtInTx`, `findPrimaryContactEmailInTx`, `findMemberByPrimaryContactEmailInTx`) + Drizzle adapter implementations using `runInTenant` + RLS. Added `F7MemberRecipient` + `F7MemberHaltSummary` projection types. **Architectural decision** (deviation from plan): F3 use-cases for `setMemberHalt` + `markBroadcastsAcknowledged` mutate flag columns ONLY — they do NOT emit cross-module audit events. F7's caller (Phase 3+ T060 bridge adapter) emits `broadcast_member_dispatch_resumed` + `member_acknowledged_broadcasts_terms` via F7's own audit-port + adapter. Rationale: keeping F3's `audit_event_type` DB-enum writes free of F7-specific literals + preserving F7 → F3 dependency direction per Constitution Principle III. F3 audit-port comment block documents the decision. Updated 4 mock test files (`bulk-action-cap.test.ts`, `bulk-action-branches.test.ts`, `inline-edit.test.ts`, `self-service-whitelist.test.ts`) with stubs for the 6 new repo methods.
- [X] T030 Extend `src/modules/plans/index.ts` with `getPlanForMember(deps, memberId)`. **Implemented 2026-04-30 Batch C**: composes F3 member identity lookup (via injected `MemberPlanIdentityLookup` port — F2 → F3 dependency abstracted; Phase 3+ T061 bridge adapter wires F3's `getMember` into the port) + F2 plan lookup (via existing `planRepo.findOne`). Returns `{planId, planCode, eblastPerYear}` from `BenefitMatrix.eblast_per_year` for FR-002 precondition `a` + FR-009 + benefits page entitlement. Discriminated `PlanLookupError` covers `member_not_found` + `plan_not_found` + `member_no_eblast_quota` + `server_error`. Exported via F2 barrel along with `MemberPlanSummary` + `MemberPlanIdentityLookup` + `GetPlanForMemberDeps` types.

### 2.5 Cross-cutting infrastructure

- [X] T031 [P] Create kill-switch helper in `src/modules/broadcasts/infrastructure/kill-switch.ts` — `assertF7Enabled()` reads `FEATURE_F7_BROADCASTS` and throws `F7DisabledError` if false. Wired into every API route handler at the start of execution. **Implemented 2026-04-30 Batch D**: exports `assertF7Enabled()` + `isF7Enabled()` + `F7DisabledError` (custom Error with `kind='feature_disabled'`). Reads `env.features.f7Broadcasts`. **T023 sanity test now GREEN** (1/12 + 11 todo).
- [X] T032 [P] Create runbook stubs in `docs/runbooks/`:
  - `broadcast-deliverability-incident.md` — bounce/complaint spike triage + per-broadcast 5% halt clear procedure (Q14)
  - `broadcast-cancel-too-late.md` — recipient already received but admin needs to follow up
  - `breach-notification.md` — PDPA §37 24h + GDPR Art. 33 72h cross-cutting workflow (CHK019)
  - `credential-compromise.md` — cross-cutting F1+F4+F5+F7 secret-rotation procedure (CHK041)
  - `broadcasts-stuck-sending.md` — 24h stuck-`sending` reconciliation + Resend dashboard cross-check
  - `broadcasts-dispatch-failure.md` — dispatch_failure_rate >10%/1h paging response
  - `broadcasts-webhook-attack.md` — signature-rejection spike investigation
  - `broadcasts-perf-regression.md` — p95 budget breach response
  - `broadcasts-queue-overflow.md` — queue-pending >8000 backlog response
  - `broadcasts-halt-clear.md` — admin clear-halt walkthrough

  **Implemented 2026-04-30 Batch D**: 10 runbooks authored at full content depth (~80 LOC each) following F4/F5 structure (H1 + Owner + Severity + Source signal + Audit event + Last reviewed + Status: SPEC banner + Symptom + Why this matters + Triage 5-step + Escalation + Recovery + Prevention). Each documents emit sites + audit event types that land in Phase 3+ (T036+).
- [X] T033 [P] Create `docs/observability.md § F7 Email Broadcast` section documenting: 16 metrics + 11 alerts + distributed-trace span set + sample rates (10% prod / 100% dev/staging — perf.md CHK049) + alert rules table. **Implemented 2026-04-30 Batch D**: appended `## 22. F7 Email Broadcast — metrics catalogue (T033)` after F5's § 21. Subsections: 22.1 metrics catalogue (16 rows: counters/histograms/gauges with cardinality discipline) · 22.2 SLO targets (10 SLOs per SC-010 / Q6) · 22.3 alert rules (11 alerts mapped to runbooks) · 22.4 logging redact rules (HMAC tokens, recipient emails, raw HTML body, rejection reason) · 22.5 sample rates · 22.6 runbook index · 22.7 dashboard panels · 22.8 alert routing.
- [X] T034 Create `docs/compliance/processing-records.md § F7` (PDPA §39 + GDPR Art. 30 record-of-processing entry per Constitution § Compliance + privacy.md CHK054). **Implemented 2026-04-30 Batch D**: created `docs/compliance/` directory + `processing-records.md` from scratch with file-level header documenting purpose + § F7 entry. Sections: Controller / Processors (Vercel + Neon + Resend + Upstash + Sentry) / Data subjects / Categories of personal data / Purpose / Recipients / Cross-border transfers / Retention periods (5y broadcasts + indefinite suppressions) / Technical + organisational measures (RLS+FORCE, sanitisation, HMAC tokens, signed webhooks, append-only audit, rate limiting, encryption) / Data-subject rights procedures (Art. 15–22) / DPO contact placeholder / Update history. F1/F4/F5 entries explicitly out-of-scope (Constitution-mandated compliance backlog noted at top of file).
- [X] T035 [P] Add Tiptap dynamic-import boilerplate to `src/components/ui/tiptap-loader.tsx` — `next/dynamic(() => import(...), { ssr: false })`. **Implemented 2026-04-30 Batch D**: exports `loadTiptapEditor<TProps>(loader)` factory function returning a `next/dynamic`-wrapped client component with shimmer skeleton loading state (ARIA-live polite + reduced-motion CSS). Phase 3+ T082 calls this with their editor module to lazy-load Tiptap (≈80KB gzipped) only on the compose surface. Approach intentional: `useEditor` is a hook (cannot be dynamically imported standalone); the loader wraps the WHOLE editor component instead.

**Checkpoint**: Foundation ready. `pnpm test:integration` runs `tenant-isolation.test.ts` + `kill-switch.test.ts` + `rls-coverage.test.ts` extension — all 3 GREEN. User story phases can now begin in priority order.

---

## Phase 3: User Story 1 — Member composes and submits an E-Blast (Priority: P1) 🎯 MVP

**Goal**: Signed-in member with quota remaining can compose subject + body + segment + (optional) schedule + preview + submit for admin review. Submission persists with `status='submitted'`, reserves a quota slot, queues admin notification, audits `broadcast_submitted`.

**Independent Test**: Seed Premium Corporate member (eblast_per_year=6, used=0). Sign in. Open `/portal/benefits/e-blasts`. Click "Compose new E-Blast". Fill subject + body + segment "All members". Click Submit. Verify (a) row persisted with status=submitted, (b) quota display "5 remaining + 1 reserved", (c) admin queue endpoint shows the row, (d) audit log has `broadcast_submitted` event with actor + segment + estimated_count.

### Tests for User Story 1 (RED FIRST per Principle II)

- [X] T036 [P] [US1] RED contract test `tests/contract/broadcasts/post-broadcasts-draft.contract.test.ts` — request/response zod shapes for POST /api/broadcasts/draft (create) and PUT /api/broadcasts/draft (update).
- [X] T037 [P] [US1] RED contract test `tests/contract/broadcasts/post-broadcasts-submit.contract.test.ts` — covers all 11 FR-002 precondition error codes (a–k) including `broadcast_member_halted_pending_review` (R3-NEW-1).
- [X] T038 [P] [US1] RED unit test `tests/unit/broadcasts/domain/broadcast-state-machine.test.ts` — every legal transition + every illegal transition rejected; coverage 100% on all 8 statuses.
- [X] T039 [P] [US1] RED unit test `tests/unit/broadcasts/domain/quota-counter.test.ts` — invariants (`used + reserved ≤ cap`, `remaining = cap - used - reserved`, never negative).
- [X] T040 [P] [US1] RED unit test `tests/unit/broadcasts/domain/email-lower.test.ts` — lowercase + trim normalisation snapshot tests.
- [X] T041 [P] [US1] RED unit test `tests/unit/broadcasts/domain/invariants.test.ts` — quota-counter-non-negative + one-active-broadcast-state + suppression-tenant-scoped.
- [X] T042 [P] [US1] RED unit test `tests/unit/broadcasts/application/sanitize-html.test.ts` — 30+ snapshot payloads exercising every allowlist tag + every forbidden tag (`<script>`, `<style>`, `<iframe>`, `<form>`, `<link>`, `<meta>`, `<base>`, `<object>`, `<embed>`, `<svg>`, `<img>`, `on*` handlers, inline `style`, `javascript:` URLs, `data:` URLs). Determinism asserted (same input → same output across runs).
- [X] T043 [P] [US1] RED unit test `tests/unit/broadcasts/application/validate-custom-recipients.test.ts` — FR-015d 3-source resolution (members.primary_contact_email + contacts.email + event_attendees.email stub) + RFC-5321 format reject + 100-entry cap + lowercase+trim normalisation + empty-list reject.
- [X] T044 [P] [US1] RED unit test `tests/unit/broadcasts/application/resolve-segment-recipients.test.ts` — all 4 segment types + suppression filter + member-self-exclusion (Q16 FR-015c) + member_missing_primary_contact emit + 5k cap (FR-016a).
- [X] T045 [P] [US1] RED unit test `tests/unit/broadcasts/application/submit-broadcast.test.ts` — ALL 11 preconditions a–k. **100% branch coverage** (security-critical per Principle II).
- [X] T046 [P] [US1] RED unit test `tests/unit/broadcasts/application/compute-quota-counter.test.ts` — derived view from `status IN ('submitted','approved')` count + `status='sent' AND quota_year_consumed=Y` count.
- [X] T047 [P] [US1] RED integration test `tests/integration/broadcasts/html-sanitiser.test.ts` — 30+ payload set asserts every forbidden construct stripped at the Application boundary; raw body NEVER persisted (`SELECT body_html FROM broadcasts WHERE broadcast_id=$1` returns sanitised only).
- [X] T048 [P] [US1] RED integration test `tests/integration/broadcasts/custom-recipient-validation.test.ts` — FR-015d branches: known member-primary / known contact / known event-attendee / unknown → reject 422 with `broadcast_custom_recipient_unknown` listing each unresolved address.
- [X] T049 [P] [US1] RED integration test `tests/integration/broadcasts/audience-cap.test.ts` — seed >5,000 in-segment recipients → submit → reject with `broadcast_audience_too_large` + audit emitted (FR-016a / Q7).
- [X] T050 [P] [US1] RED integration test `tests/integration/broadcasts/event-attendees-stub.test.ts` — F7 stub returns `[]` → segment resolves empty → submission rejected with `broadcast_empty_segment_blocked` (FR-015a / Q5).
- [X] T051 [P] [US1] RED integration test `tests/integration/broadcasts/halt-flag-precondition.test.ts` — member with `broadcasts_halted_until_admin_review = true` attempts submit → 422 `broadcast_member_halted_pending_review` + audit + no row + no reservation (FR-002 precondition `k` / R3-NEW-1).
- [X] T052 [P] [US1] RED E2E test `tests/e2e/broadcast-compose-and-submit.spec.ts` — full happy-path with Tiptap editor + segment picker + preview + submit + confirmation. Covers AS1.
- [X] T053 [P] [US1] RED E2E test `tests/e2e/broadcast-quota-block.spec.ts` — member with quota exhausted sees disabled CTA + bilingual explainer (AS2). Direct API submit returns 409 `quota_exhausted`.
- [X] T054 [P] [US1] RED E2E test `tests/e2e/broadcast-draft-restore.spec.ts` — close browser mid-compose → reopen within 30 days → draft restored from `status='draft'` row (AS3).
- [X] T055 [P] [US1] RED E2E test `tests/e2e/broadcast-empty-segment.spec.ts` — submit with all-suppressed custom list → reject + bilingual error (AS4).
- [X] T056 [P] [US1] RED E2E test `tests/e2e/broadcast-rate-limit.spec.ts` — submit 11 broadcasts in 24h window → 11th rate-limited (AS5).

### Implementation for User Story 1

- [X] T057 [US1] Implement Domain `Broadcast` aggregate root in `src/modules/broadcasts/domain/broadcast.ts` — state machine with all 8 transitions + immutable-after-submit invariant + dual-actor field validation (Q12). Tests T038 + T041 GREEN.
- [X] T058 [US1] Implement Infrastructure DOMPurify sanitiser in `src/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer.ts` — wraps `isomorphic-dompurify` with explicit `ALLOWED_TAGS` + `ALLOWED_ATTR` per FR-002a. URL scheme allowlist `http:|https:|mailto:`. Determinism via DOMPurify config singleton. Test T042 + T047 GREEN.
- [X] T059 [US1] Implement Infrastructure email-validator in `src/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator.ts` — wraps `email-validator` package + lowercase+trim normalisation.
- [X] T060 [US1] Implement Infrastructure F3 bridge in `src/modules/broadcasts/infrastructure/members-bridge.ts` — concrete impl of `MembersBridgePort` calling F3 barrel exports from T029.
- [X] T061 [US1] Implement Infrastructure F2 bridge in `src/modules/broadcasts/infrastructure/plans-bridge.ts` — concrete impl of `PlansBridgePort` calling F2 barrel export from T030.
- [X] T062 [US1] Implement Infrastructure event-attendees stub in `src/modules/broadcasts/infrastructure/event-attendees-stub.ts` — `EventAttendeesRepository` returning `[]` (FR-015a / Q5). Test T050 GREEN.
- [X] T063 [US1] Implement Infrastructure broadcasts-repo + broadcast-segment-definitions-repo Drizzle adapters in `src/modules/broadcasts/infrastructure/db/`.
- [X] T064 [US1] Implement Application `sanitize-html.ts` use case wrapping `HtmlSanitizerPort`. Test T042 GREEN.
- [X] T065 [US1] Implement Application `validate-custom-recipients.ts` (FR-015d) wrapping `EmailValidatorPort` + `MembersBridgePort` + `EventAttendeesRepository` stub. Test T043 + T048 GREEN.
- [X] T066 [US1] Implement Application `resolve-segment-recipients.ts` (FR-015c + FR-015a + FR-016a + FR-017 + Q16 self-exclusion + Q8 primary-contact-only + member_missing_primary_contact emit). Test T044 + T049 + T050 GREEN.
- [X] T067 [US1] Implement Application `compute-quota-counter.ts` (FR-003 derived view). Test T046 GREEN.
- [X] T068 [US1] Implement Application `save-draft.ts` (FR-001) — upsert `broadcasts(status='draft')` + audit `broadcast_drafted` (one event per create; subsequent edits do NOT re-audit per FR-004).
- [X] T069 [US1] Implement Application `submit-broadcast.ts` (FR-002 + FR-003 + FR-005) — orchestrates: authz → 11 preconditions a–k → sanitiser → segment resolver → reservation insert → audit `broadcast_submitted` with `actor_role` + member_id + segment + estimated_count → enqueue admin notification via `EmailTransactionalPort` → commit. Test T045 + T051 GREEN.
- [X] T070 [US1] Implement Application `enforce-tenant-context.ts` helper — cross-tenant probe refusal returning 404 (FR-037) + `broadcast_cross_member_probe` audit.
- [X] T071 [US1] Wire RBAC in `src/modules/auth/rbac-guard.ts` extension — add `broadcasts:create_draft`, `broadcasts:submit`, `broadcasts:read_own`. Member role permitted; admin role permitted (for proxy); manager role denied.
- [X] T072 [US1] Add Upstash rate-limiter for submit endpoint — 10 submissions per member per rolling 24h (Spec § Assumptions). Test T056 GREEN.

### API endpoints for US1

- [X] T073 [US1] Implement `POST /api/broadcasts/draft` in `src/app/api/broadcasts/draft/route.ts` — wraps Application `save-draft.ts`. zod-validate body per contracts/broadcasts-api.md § 1.1. Kill-switch guard. Test T036 GREEN.
- [X] T074 [US1] Implement `PUT /api/broadcasts/draft` in same file — update existing draft. Reject 409 `broadcast_immutable_after_submit` if `status != 'draft'`. Test T036 GREEN.
- [X] T075 [US1] Implement `DELETE /api/broadcasts/draft/[id]` — delete draft (no audit for draft-delete — drafts are user-controlled scratch space).
- [X] T076 [US1] Implement `POST /api/broadcasts/submit` in `src/app/api/broadcasts/submit/route.ts` — wraps Application `submit-broadcast.ts`. Returns 200 with `broadcastId` + `submittedAt` + `estimatedRecipientCount` + `reservedQuotaSlot=true` + `reviewSlaTargetHours=48`. Tests T037 + T045 + T047–T056 GREEN.
- [X] T077 [US1] Implement `GET /api/broadcasts/[id]` in `src/app/api/broadcasts/[id]/route.ts` — member views own broadcast detail. 404 + `broadcast_cross_member_probe` audit on mismatch.
- [X] T078 [US1] Implement `GET /api/broadcasts/quota` in `src/app/api/broadcasts/quota/route.ts` — returns derived quota counter for current quota year. Authz: own member only.

### Member-facing UI for US1

- [X] T079 [US1] Create compose page `src/app/(member)/portal/broadcasts/new/page.tsx` — server-rendered shell. `FormContainer` (42rem). Loads draft if URL `?draftId=...`.
- [X] T080 [US1] Create loading skeleton `src/app/(member)/portal/broadcasts/new/loading.tsx` — shimmer for editor area + toolbar row + button per Plan § Skeleton shimmer placement matrix.
- [X] T081 [US1] [P] Create `compose-form.tsx` client component — `react-hook-form` + zod. Wraps Tiptap editor + segment picker + custom-list input + scheduling + preview + submit button.
- [X] T082 [US1] [P] Create Tiptap editor wrapper `tiptap-editor.tsx` — `'use client'`. Uses `useEditor` from `@tiptap/react`. StarterKit minus disabled Image extension (R2-NEW-1). Image extension MUST be disabled in `extensions: [...]` config — guards against `<img>` re-introduction. ARIA-live region paired with editor announcing state changes per Plan § Accessibility deep-dive CHK029. Sanitiser-strip-warn paste handler per FR-002a R2-NEW-2.
- [X] T083 [US1] [P] Create `tiptap-toolbar.tsx` — bold / italic / underline / lists / link buttons with bilingual labels + Ctrl+B/I/U keyboard shortcuts (with `event.isComposing` IME guard per perf.md CHK059 / i18n.md CHK059).
- [X] T084 [US1] [P] Create `editor-skeleton.tsx` shimmer for Tiptap dynamic-import loading state.
- [X] T085 [US1] [P] Create `segment-picker.tsx` — fixed segment options + custom-list paste textarea. `aria-describedby` for empty-segment / cap-exceeded warnings.
- [X] T086 [US1] [P] Create `custom-list-input.tsx` — textarea with per-entry validation feedback. Lowercase+trim preview. 100-entry counter.
- [X] T087 [US1] [P] Create `schedule-picker.tsx` — optional future-send date+time picker (uses TH locale Buddhist Era display via `@js-joda/timezone` + i18n).
- [X] T088 [US1] [P] Create `preview-pane.tsx` — split-pane email preview using sanitised body. Re-renders on every editor change.
- [X] T089 [US1] [P] Create `quota-display.tsx` — used / reserved / remaining counters fed by `GET /api/broadcasts/quota`.
- [X] T090 [US1] [P] Create `submit-button.tsx` — disabled state per FR-002 preconditions. Member-facing latency display per perf.md CHK053 (8s spinner timeout → "Taking longer than expected" toast).
- [X] T091 [US1] Wire `marketing-acknowledgement-banner.tsx` (Q15 + R3-NEW-2) at `src/app/(member)/portal/_components/`. Server-rendered. Trigger conditions per Q15: `member` role + tenant has F7 + `broadcasts_acknowledged_at IS NULL` + `eblast_per_year > 0 OR is_active`. "Acknowledge" CTA emits `member_acknowledged_broadcasts_terms` audit + sets `broadcasts_acknowledged_at`. "Remind me later" link records nothing. Per-tenant scope per Q19. Banner-dismissal focus return per a11y.md CHK042.
- [X] T092 [US1] [P] Add i18n keys for US1 in `src/i18n/messages/{en,th,sv}.json`:
  - `portal.broadcasts.compose.*` (~30 keys)
  - `portal.broadcasts.compose.editor.aria.*` (Tiptap state SR announcements per a11y.md CHK029 / i18n.md CHK006)
  - `portal.broadcasts.compose.editor.announcements.*`
  - `portal.broadcasts.errors.*` (11 precondition error codes — a–k)
  - `portal.broadcasts.banner.acknowledgement.*` (Q15 banner copy — bilingual EN/TH/SV review by chamber TH/SV liaison required at /speckit.ship per i18n.md CHK041)
  - `portal.broadcasts.empty.*`
  - `portal.broadcasts.toast.*`

**Checkpoint US1**: Member can create draft + edit subject/body via Tiptap + pick segment + preview + submit. Submission reserves quota slot + emits `broadcast_submitted`. **MVP slice ½ done.**

---

## Phase 4: User Story 2 — Admin reviews + approves/rejects (Priority: P1) 🎯 MVP

**Goal**: Admin opens review queue, previews each pending submission, approves (now or schedule) OR rejects (with required reason). Approval transitions to `approved → sending` (now) OR `approved` with `scheduled_for` (schedule). Rejection releases quota reservation + emails member with verbatim reason.

**Independent Test**: With one `submitted` broadcast from US1, sign in as admin, open `/admin/broadcasts?status=submitted`, click "Approve & send now". Verify status transitions, member receives email, audit log updated. Repeat with second broadcast, click "Reject", enter reason, verify quota release + member email.

### Tests for User Story 2 (RED FIRST)

- [ ] T093 [P] [US2] RED contract test `tests/contract/broadcasts/post-admin-broadcasts-approve.contract.test.ts` — request/response shapes for POST `/api/admin/broadcasts/[id]/approve` (with `mode: 'send_now' | 'schedule'` + optional `scheduledFor`).
- [ ] T094 [P] [US2] RED contract test `tests/contract/broadcasts/post-admin-broadcasts-reject.contract.test.ts` — required `reason` (≥1 non-whitespace char).
- [ ] T095 [P] [US2] RED contract test `tests/contract/broadcasts/post-admin-broadcasts-proxy-submit.contract.test.ts` — admin-on-behalf-of-member dual-actor (Q12).
- [ ] T096 [P] [US2] RED unit test `tests/unit/broadcasts/application/approve-broadcast.test.ts` — both modes + concurrent-action guard + state-check + Resend dispatch invocation + audit emission.
- [ ] T097 [P] [US2] RED unit test `tests/unit/broadcasts/application/reject-broadcast.test.ts` — non-empty reason required + sha256 hash audit + reservation release + member-notification queue.
- [ ] T098 [P] [US2] RED unit test `tests/unit/broadcasts/application/proxy-submit-broadcast.test.ts` — Q12 dual-actor (`requested_by_member_id != submitted_by_user_id`, `actor_role = 'admin_proxy'`).
- [ ] T099 [P] [US2] RED E2E test `tests/e2e/admin-review-queue.spec.ts` — covers AS1–AS6: queue list / approve send-now / reject with reason / approve schedule / manager read-only / concurrent admin race.

### Implementation for User Story 2

- [ ] T100 [US2] Implement Application `approve-broadcast.ts` — authz `admin` only → `SELECT FOR UPDATE` + state-check `status='submitted'` → if `mode='send_now'`: call `BroadcastsGateway.createBroadcast` + `sendBroadcast` (Resend Broadcasts API) outside tx with stable idempotency key `broadcast-{tenantId}-{broadcastId}` per FR-020 → `UPDATE status='approved'` then `UPDATE status='sending', resendBroadcastId=$1` → audit `broadcast_approved` + `broadcast_send_started` → enqueue member notification → commit. If `mode='schedule'`: `UPDATE status='approved', scheduledFor=$1` → audit `broadcast_approved` (with `scheduledFor`) → commit. Test T096 GREEN.
- [ ] T101 [US2] Implement Application `reject-broadcast.ts` — authz → state-check → reason validation (≥1 non-whitespace) → `UPDATE status='rejected', rejectionReason=$1` → release quota reservation (derived from new state per FR-003) → audit `broadcast_rejected` with `rejection_reason_hash = sha256(reason)` (NOT raw reason) → enqueue member notification with verbatim reason → commit. Test T097 GREEN.
- [ ] T102 [US2] Implement Application `proxy-submit-broadcast.ts` — Q12 admin-on-behalf-of-member. Same logic as `submit-broadcast.ts` but `submittedByUserId = admin.userId`, `requestedByMemberId = proxiedMemberId`, `actorRole = 'admin_proxy'`. Audit `broadcast_submitted` with both ids. Test T098 GREEN.
- [ ] T103 [US2] Implement Application `cancel-broadcast.ts` — FR-004a + Q10 cancel-cutoff policy. Authz: member-self OR admin (manager NO). State-check `status IN ('submitted','approved')`. UPDATE → cancelled + release reservation. Audit `broadcast_cancelled` with actor + actor_role + optional reason. Reject from `sending|sent|rejected|cancelled|failed_to_dispatch` with 409 + `broadcast_cancel_too_late` audit.
- [ ] T104 [US2] Implement Infrastructure Resend Broadcasts gateway in `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway.ts` — concrete `BroadcastsGatewayPort` impl wrapping Resend SDK Broadcasts API surface (`audiences.create`, `audiences.contacts.create`, `broadcasts.create`, `broadcasts.send`). Stable idempotency key. Retry policy per CHK020 (1/2/4/8/16s × 5).
- [ ] T105 [US2] Implement Infrastructure Resend Broadcasts client singleton in `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-client.ts` — reads `RESEND_BROADCASTS_API_KEY` from env. Lazy-loaded.
- [ ] T106 [US2] Implement Infrastructure email-transactional bridge in `src/modules/broadcasts/infrastructure/email-transactional-bridge.ts` — wraps F1+F4 transactional Resend client (NOT Broadcasts) for admin/member notifications about broadcasts.
- [ ] T107 [US2] Wire RBAC extension — `broadcasts:approve`, `broadcasts:reject`, `broadcasts:cancel`, `broadcasts:proxy_submit` (admin only); `broadcasts:read_queue` (admin + manager).

### API endpoints for US2

- [ ] T108 [US2] Implement `GET /api/admin/broadcasts` in `src/app/api/admin/broadcasts/route.ts` — review queue paginated + sortable + filterable (member + segment + date range). Default sort by submitted_at ASC.
- [ ] T109 [US2] Implement `POST /api/admin/broadcasts/[id]/approve` in `src/app/api/admin/broadcasts/[id]/approve/route.ts` — wraps `approve-broadcast.ts`. Test T093 GREEN.
- [ ] T110 [US2] Implement `POST /api/admin/broadcasts/[id]/reject` — wraps `reject-broadcast.ts`. Test T094 GREEN.
- [ ] T111 [US2] Implement `POST /api/admin/broadcasts/[id]/cancel` — admin-side cancel (member-side cancel is in `/api/broadcasts/[id]/cancel`).
- [ ] T112 [US2] Implement `POST /api/admin/broadcasts/proxy-submit` — wraps `proxy-submit-broadcast.ts`. Test T095 GREEN.
- [ ] T113 [US2] Implement `POST /api/broadcasts/[id]/cancel` (member-side cancel in `src/app/api/broadcasts/[id]/cancel/route.ts`) — wraps shared `cancel-broadcast.ts` use case (T103) for member-self cancel path. Member-self + admin cancel share the same Application use case per FR-004a; route handlers split for authz scoping (member-side rejects if `actor.userId != broadcast.requested_by_member_id`'s portal user).
- [ ] T114 [US2] Add Application `clear-halt.ts` — admin-only action via `POST /api/admin/members/[id]/broadcasts-halt-clear` (or via F3 admin members endpoint). Calls F3 `setMemberHalt(memberId, false)` + emits `broadcast_member_dispatch_resumed` audit. Manager role denied.

### Admin-facing UI for US2

- [ ] T115 [US2] Create admin queue page `src/app/(staff)/admin/broadcasts/page.tsx` — server-rendered. `TableContainer` (96rem). Inherits F4 invoice-list pattern.
- [ ] T116 [US2] Create loading skeleton `src/app/(staff)/admin/broadcasts/loading.tsx` — TanStack table rows shimmer (F4 pattern).
- [ ] T117 [US2] [P] Create `queue-table.tsx` — TanStack Table v8 + `@tanstack/react-virtual` virtualization at >100 rows (perf.md CHK039). Server-side sort/filter/pagination. Columns: submitted_at (relative-time), member name, subject, segment label, estimated count, status badge, actions.
- [ ] T118 [US2] [P] Create `review-actions.tsx` — Approve & send now / Approve & schedule / Reject buttons per row.
- [ ] T119 [US2] [P] Create `reject-dialog.tsx` — required free-text reason textarea (≥1 non-whitespace char). Disabled submit until valid. Auto-focus on open. ESC closes without submit.
- [ ] T120 [US2] [P] Create `proxy-submit-dialog.tsx` — Q12 admin-on-behalf-of-member. Member picker + opens compose flow.
- [ ] T121 [US2] [P] Create `halt-state-banner.tsx` (Q14 + R3-NEW-3) — top-of-page red banner when ≥1 member in tenant has `broadcasts_halted_until_admin_review = true`. Lists halted members with "Review + Clear halt" buttons. Banner-stacking-aligned roles per Plan § Banner scope and stacking.
- [ ] T122 [US2] [P] Create `clear-halt-dialog.tsx` — typed-phrase confirmation matching F4 destructive-action convention. Bilingual phrases per i18n.md CHK008. Calls T114 `clear-halt` use case.
- [ ] T123 [US2] [P] Create `manager-readonly-banner.tsx` — visible while manager role active. Persistent (no dismissal).
- [ ] T124 [US2] Create admin broadcast detail page `src/app/(staff)/admin/broadcasts/[id]/page.tsx` — `DetailContainer` (72rem). Subject + body rendered HTML + segment + recipient count + delivery breakdown placeholder (US5 wires real data) + audit timeline + Approve/Reject/Cancel actions.
- [ ] T125 [US2] Create admin broadcast detail loading skeleton `src/app/(staff)/admin/broadcasts/[id]/loading.tsx` — 4 stat-row skeletons.
- [ ] T125a-test [P] [US2] RED contract test `tests/contract/broadcasts/get-admin-broadcasts-sla-stats.contract.test.ts` (FR-013 — N2 remediation post-/speckit.analyze 2026-04-29). Asserts: (1) admin role gets 200 with `{targetSlaHours: 48, rollingWindow: '30d', medianTimeToDecisionHours, p95TimeToDecisionHours, decisionCount, bannerSeverity, computedAt}` shape per contracts/broadcasts-api.md § 2.7; (2) zero-data path returns `medianTimeToDecisionHours: null` + `bannerSeverity: 'green'`; (3) member role gets 403; (4) bannerSeverity computation green/amber/red per documented thresholds. Initial state RED.
- [ ] T125a [US2] Add 48-hour SLA target banner to admin queue page header (FR-013 — Coverage Gap C1 from /speckit.analyze). Component `src/app/(staff)/admin/broadcasts/_components/sla-banner.tsx`. Displays "Target review SLA: 48 hours · Median time-to-decision (rolling 30d): `<x>h` · p95: `<y>h`" — fed by **`GET /api/admin/broadcasts/sla-stats`** at `src/app/api/admin/broadcasts/sla-stats/route.ts` (documented in contracts/broadcasts-api.md § 2.7; computes median + p95 from `broadcasts WHERE submitted_at >= NOW() - INTERVAL '30 days' AND status IN ('approved','rejected')`). Banner color: green (within budget) / amber (>24h median or >40h p95) / red (SC-002 breach: >24h median or >48h p95). Bilingual EN/TH/SV via i18n keys `admin.broadcasts.queue.slaBanner.*` (5 keys: `targetSla` + `medianRolling30d` + `p95Rolling30d` + `withinBudget` + `breachWarning` — see T126 inventory). Per FR-013 + Q2: SLA is informational only — NO automated escalation in MVP. SC-002 enforcement is operational, not technical. Test T125a-test GREEN.
- [ ] T126 [US2] [P] Add i18n keys for US2 in `src/i18n/messages/{en,th,sv}.json`:
  - `admin.broadcasts.queue.*` (~30 keys)
  - `admin.broadcasts.queue.slaBanner.*` (5 keys: `targetSla`, `medianRolling30d`, `p95Rolling30d`, `withinBudget`, `breachWarning` — N3 remediation; T125a SLA banner copy)
  - `admin.broadcasts.review.*` (~30 keys)
  - `admin.broadcasts.reject-dialog.*`
  - `admin.broadcasts.proxy-submit.*`
  - `admin.broadcasts.halt-banner.*` (Q14)
  - `admin.broadcasts.clear-halt-dialog.*`
  - `admin.broadcasts.manager-readonly-banner.*`
  - `email.broadcastApproved.*` (transactional template)
  - `email.broadcastRejected.*`
  - `email.broadcastCancelled.*`

**Checkpoint US2**: Admin can review queue + approve/reject/cancel. Members receive transactional emails. **MVP slice complete — F7 deliverable end-to-end.**

---

## Phase 5: User Story 3 — Member sees quota + history (Priority: P2)

**Goal**: Member opens `/portal/benefits/e-blasts` and sees quota counters (sent + reserved + remaining + cap + reset date) + paginated broadcast history with status badges + delivery summary on detail.

**Independent Test**: With member having 2 sent + 1 submitted + 0 rejected in 2026 on Premium plan, sign in, open benefits page, verify quota counters + history list + click sent broadcast detail to see delivery breakdown.

### Tests for User Story 3 (RED FIRST)

- [ ] T127 [P] [US3] RED contract test `tests/contract/broadcasts/get-broadcasts-quota.contract.test.ts` — response shape per contracts/broadcasts-api.md.
- [ ] T128 [P] [US3] RED unit test for benefits-page server component — quota math + history pagination + plan-changed-mid-year explainer (AS2).
- [ ] T129 [P] [US3] RED E2E test `tests/e2e/member-quota-history.spec.ts` — covers AS1–AS9 including banner trigger conditions (Q15) + banner per-tenant scope (Q19) + banner dismissal focus return (a11y.md CHK042).

### Implementation for User Story 3

- [ ] T130 [US3] Create benefits page `src/app/(member)/portal/benefits/e-blasts/page.tsx` — `DetailContainer` (72rem). Server-rendered. Fetches via Application `compute-quota-counter.ts` + own-broadcasts list. Cache Components `revalidate: 60s` per-(tenant, member) per perf.md CHK056.
- [ ] T131 [US3] Create benefits page loading skeleton — 5 row history skeletons.
- [ ] T132 [US3] [P] Create benefits page UI components:
  - `quota-counters.tsx` — used / reserved / remaining / cap / reset-date with bilingual labels + Buddhist Era display for TH locale per i18n.md CHK017
  - `broadcast-history-table.tsx` — paginated history with status badges
  - `plan-changed-mid-year-explainer.tsx` — microcopy when plan changed in current quota year (AS2)
  - `empty-state.tsx` — first-broadcast empty state per Plan § Empty-state catalog
- [ ] T133 [US3] Create member broadcast detail page `src/app/(member)/portal/broadcasts/[id]/page.tsx` — read-only post-submit view with delivery breakdown.
- [ ] T134 [US3] Create member broadcast detail loading skeleton.
- [ ] T135 [US3] [P] Add i18n keys for US3 in `src/i18n/messages/{en,th,sv}.json`:
  - `portal.benefits.eblast.*` (~25 keys)
  - `portal.broadcasts.detail.*` (~15 keys)
  - `portal.broadcasts.history.*`
  - `portal.broadcasts.quota.*` (counters + reset-date copy + Buddhist Era display per i18n.md CHK017)

**Checkpoint US3**: Member benefits page shows quota counters + history + detail.

---

## Phase 6: User Story 4 — Public unsubscribe + suppression (Priority: P2)

**Goal**: Recipient clicks unsubscribe link → lands on public unauthenticated page → confirms suppression. Tenant-scoped suppression list. Future broadcasts in tenant exclude that email.

**Independent Test**: After a US1+US2 broadcast lands in test mailbox, click unsubscribe link. Verify (a) public page renders in resolved locale, (b) reload shows idempotent "Already unsubscribed", (c) second broadcast to same recipient excludes the email.

### Tests for User Story 4 (RED FIRST)

- [ ] T136 [P] [US4] RED contract test `tests/contract/broadcasts/get-unsubscribe-token.contract.test.ts` — token format + locale resolution + error responses per contracts/unsubscribe-public.md.
- [ ] T137 [P] [US4] RED unit test `tests/unit/broadcasts/application/unsubscribe-recipient.test.ts` — token verify success + replay idempotent + tampered → reject + cross-tenant token → reject (FR-031, FR-032).
- [ ] T138 [P] [US4] RED integration test `tests/integration/broadcasts/unsubscribe-token.test.ts` — happy path + replay idempotent + tampered + cross-tenant.
- [ ] T139 [P] [US4] RED E2E test `tests/e2e/recipient-unsubscribe.spec.ts` — covers AS1–AS6 including idempotent re-load + bilingual fallback for invalid token + suppression-list filter on next broadcast.

### Implementation for User Story 4

- [ ] T140 [US4] Implement Infrastructure HMAC unsubscribe-token signer in `src/modules/broadcasts/infrastructure/unsubscribe-token/hmac-signer.ts` — HMAC-SHA256 over `(tenant_id, broadcast_id, recipient_email_lower)` using `UNSUBSCRIBE_TOKEN_SECRET`. Token format includes optional signed `lang` hint (i18n.md CHK011).
- [ ] T141 [US4] Implement Infrastructure HMAC unsubscribe-token verifier in `src/modules/broadcasts/infrastructure/unsubscribe-token/hmac-verifier.ts` — `crypto.timingSafeEqual` comparison (timing-attack-resistant per F1 pattern).
- [ ] T142 [US4] Implement Application `unsubscribe-recipient.ts` (FR-031) — verify HMAC → on success, parse `(tenantId, broadcastId, emailLower)` → enter `runInTenant(ctx, ...)` → upsert `marketingUnsubscribes(tenantId, emailLower) ON CONFLICT DO NOTHING` with `unsubscribed_at = now()`, `member_id = resolveMemberByEmail(emailLower)`, `source_token = sha256(token)`, optional `reason` if recipient typed feedback → audit `broadcast_unsubscribed` → render confirmation page → commit. On token-verify-fail: render fallback page + audit `broadcast_unsubscribe_token_invalid` (no row mutation).
- [ ] T143 [US4] Implement Infrastructure marketing-unsubscribes Drizzle repo in `src/modules/broadcasts/infrastructure/db/marketing-unsubscribes-repo.drizzle.ts`.
- [ ] T144 [US4] Create public unsubscribe page `src/app/unsubscribe/[token]/page.tsx` — server-rendered (no JS dependency for completion). Locale resolution: `lang` query param (signed in token) → Accept-Language → tenant-default → EN per FR-039 + i18n.md CHK010. Webhook+unsubscribe pre-tenant bypass context per Plan § Constitution Principle I clause 2 narrow exceptions.
- [ ] T145 [US4] Create public unsubscribe error/fallback page state — bilingual "Link is invalid or expired — please contact `<tenant_support_email>`" per FR-032.
- [ ] T146 [US4] Create public unsubscribe success/idempotent page state — "You are already unsubscribed" if replay (FR-030 idempotency).
- [ ] T147 [US4] Wire HTML email template footer in `src/modules/broadcasts/infrastructure/resend/email-template.ts` — generate Resend HTML body with unsubscribe link `https://<tenant-host>/unsubscribe/{token}`. Bilingual unsubscribe CTA in resolved recipient locale per i18n.md CHK034.
- [ ] T148 [US4] [P] Add i18n keys for US4 in `src/i18n/messages/{en,th,sv}.json`:
  - `public.unsubscribe.*` (~15 keys)
  - `email.broadcastFooter.*` (unsubscribe CTA + tenant identifier + physical address)

**Checkpoint US4**: Recipients can unsubscribe via public page. Suppression list tenant-scoped. Unsubscribe link wired into email footer.

---

## Phase 7: User Story 5 — Resend webhook delivery tracking (Priority: P2)

**Goal**: Resend posts per-recipient delivery events to webhook endpoint. F7 ingests events idempotently (`(tenant_id, resend_event_id) UNIQUE`), records on `broadcast_deliveries` rows, updates aggregate counts, transitions `sending → sent` after all expected events OR 24h timeout, **consumes quota** at this transition (only state transition that consumes member's annual counter).

**Independent Test**: Simulate Resend webhook sequence on a `sending` broadcast (100 sent + 95 delivered + 3 bounced + 2 complained events). Verify (a) 100 delivery rows created with `(tenant_id, delivery_id)` PK + dedup on `resend_event_id`, (b) aggregate counts match, (c) broadcast transitions `sending → sent`, (d) quota consumed at transition, (e) replay is idempotent.

### Tests for User Story 5 (RED FIRST)

- [ ] T149 [P] [US5] RED contract test `tests/contract/broadcasts/post-webhooks-resend-broadcasts-events.contract.test.ts` — one test per handled event type (`email.sent`, `email.delivered`, `email.bounced`, `email.complained`).
- [ ] T150 [P] [US5] RED unit test `tests/unit/broadcasts/application/process-webhook-event.test.ts` — root dispatcher routing per event type + signature-verification refusal pre-parse.
- [ ] T151 [P] [US5] RED integration test `tests/integration/broadcasts/webhook-signature.test.ts` — valid signature accepted; invalid signature rejected 401 + `broadcast_webhook_signature_rejected` audit; refused BEFORE body parse (zero state mutation).
- [ ] T152 [P] [US5] RED integration test `tests/integration/broadcasts/webhook-idempotency.test.ts` — same `resend_event_id` upserted twice → second is no-op (FR-025 `(tenant_id, resend_event_id)` UNIQUE).
- [ ] T152a [P] [US5] RED integration test `tests/integration/broadcasts/transactional-broadcast-separation.test.ts` (FR-019 — Coverage Gap C4 from /speckit.analyze) — asserts the two Resend API products are isolated: (1) F1 transactional email (password reset) → does NOT create row in `broadcast_deliveries`; (2) F1 transactional email recipient → does NOT appear in F7 `marketing_unsubscribes` even when recipient hits unsubscribe link in F1 email (Resend transactional uses its own suppression list, not F7's); (3) F7 broadcast → does NOT use F1 transactional sender identity / suppression; (4) F7 webhook events do NOT mutate F1 transactional state. Verifies the "separate API products with separate suppression lists and separate sending IPs" invariant from FR-019.

### Implementation for User Story 5

- [ ] T153 [US5] Implement Infrastructure Resend Broadcasts webhook verifier in `src/modules/broadcasts/infrastructure/resend/resend-broadcasts-webhook-verifier.ts` — wraps Resend SDK signature verification (Svix HMAC-SHA256). Reads `RESEND_BROADCASTS_WEBHOOK_SECRET`. Refuses BEFORE body parse.
- [ ] T154 [US5] Implement Application `process-webhook-event.ts` — root dispatcher. Verify signature → parse event → upsert `broadcast_deliveries(tenant_id, resend_event_id) ON CONFLICT DO NOTHING` → resolve broadcast via `resend_broadcast_id` lookup → enter `runInTenant(ctx, ...)` → branch on event type (delegates to `handle-delivered-event.ts` / `handle-bounced-event.ts` / `handle-complained-event.ts`).
- [ ] T155 [US5] [P] Implement Application `handle-delivered-event.ts` — insert delivery row status=`delivered`. After all expected events received OR 24h timeout, transition `sending → sent` + stamp `quota_consumed_at = now()` + set `quota_year_consumed = currentQuotaYear(tenantTz, sentAt)` per FR-007 → audit `broadcast_sent` + `broadcast_quota_consumed` → enqueue summary email via F1 transactional.
- [ ] T156 [US5] [P] Implement Application `handle-bounced-event.ts` — insert delivery row status=`bounced` (or `soft_bounced`) + auto-add to `marketing_unsubscribes` with `reason='hard_bounce'` (FR-027) → audit `broadcast_suppression_applied`.
- [ ] T157 [US5] [P] Implement Application `handle-complained-event.ts` — insert delivery row status=`complained` + auto-add to suppression with `reason='complaint'` + admin alert + audit `broadcast_complaint_received`. Compute per-broadcast complaint rate; if >5% (Q14 SC-005 (b)), set `members.broadcasts_halted_until_admin_review = true` + audit `broadcast_complaint_rate_per_broadcast_breach` (high severity) + page on-call admin.
- [ ] T158 [US5] Implement Application `handle-sent-event.ts` — insert delivery row status=`sent` (Resend accepted from us; not yet delivered to recipient inbox).
- [ ] T159 [US5] Implement broadcast-deliveries Drizzle repo in `src/modules/broadcasts/infrastructure/db/broadcast-deliveries-repo.drizzle.ts`.
- [ ] T160 [US5] Implement webhook handler `src/app/api/webhooks/resend-broadcasts/route.ts` — **Node.js runtime** (NOT Edge — required for raw-body access per Plan § Constraints). zod-validate event payload AFTER signature verification. Calls Application `process-webhook-event.ts`. Tests T149 + T151 + T152 GREEN.
- [ ] T161 [US5] Implement Application `reconcile-stuck-sending.ts` (R2-NEW-3) — runs at 24h timeout per FR-028. BEFORE consuming quota, calls `BroadcastsGateway.retrieveBroadcast({id: resend_broadcast_id})`. If 404 → transition to `failed_to_dispatch` + release quota + audit `broadcast_resend_resource_missing` + alert admin. If found → proceed with `sent` transition.
- [ ] T162 [US5] Wire reconciliation cron-job.org HTTP trigger at `/api/cron/broadcasts/reconcile-stuck-sending` (15-min cadence, Bearer auth via `CRON_SECRET`) per perf.md CHK033.
- [ ] T163 [US5] [P] Add i18n keys for US5 in `src/i18n/messages/{en,th,sv}.json`:
  - `email.broadcastDelivered.*` (transactional summary template)
  - `admin.broadcasts.deliverySummary.*`
  - `admin.broadcasts.complaintRateBreach.*`

**Checkpoint US5**: Webhook events ingested idempotently. Broadcasts transition to `sent` + quota consumed. Auto-suppression on bounce/complaint. Per-broadcast 5% complaint halt fires + auto-halts member.

---

## Phase 8: User Story 6 — Scheduled future-dated send via cron (Priority: P3)

**Goal**: Member submits with `scheduled_for` set. Admin approves with schedule. Cron handler fires every 5 min, picks up `approved` broadcasts whose `scheduled_for ≤ now()`, calls Resend, transitions `approved → sending`. From there US5 takes over.

**Independent Test**: Submit + approve broadcast with `scheduled_for = now() + 1h`. Wait. Verify Resend API called within 5 min of `scheduled_for`. Verify `status = approved → sending`. Verify cron concurrency guard (no double-dispatch).

### Tests for User Story 6 (RED FIRST)

- [ ] T164 [P] [US6] RED unit test `tests/unit/broadcasts/application/dispatch-scheduled-broadcast.test.ts` — picks up due rows + per-(tenant, broadcast) advisory lock + Resend dispatch + state transition + audit.
- [ ] T165 [P] [US6] RED integration test `tests/integration/broadcasts/cron-dispatch-idempotency.test.ts` — two simulated concurrent cron invocations on same `approved` row → asserts exactly ONE Resend dispatch + ONE `sending` transition via `SELECT FOR UPDATE SKIP LOCKED` + `pg_advisory_xact_lock(hashtextextended('broadcasts:'||tenant_id||':'||broadcast_id, 0))`.
- [ ] T166 [P] [US6] RED E2E test `tests/e2e/scheduled-send-cron.spec.ts` — full schedule → cron fire → dispatch flow.
- [ ] T167 [P] [US6] RED E2E test `tests/e2e/broadcast-cancel-too-late.spec.ts` — covers AS6 of US6 + AS3 cron concurrent guard.

### Implementation for User Story 6

- [ ] T168 [US6] Implement Application `dispatch-scheduled-broadcast.ts` (US6 cron handler use case) — `SELECT FOR UPDATE SKIP LOCKED` on `broadcasts WHERE status='approved' AND scheduled_for <= now()` ordered by `tenant_id ASC, scheduled_for ASC` (per-tenant fairness per perf.md CHK055) → for each row, acquire `pg_advisory_xact_lock(hashtextextended('broadcasts:'||tenant_id||':'||broadcast_id, 0))` → call Resend dispatch outside tx with stable idempotency key → `UPDATE status='sending', resend_broadcast_id=$1` → audit `broadcast_send_started` with `scheduled_for` + `actual_send_at` + `delay_seconds` → commit. Per FR-021 retry on 5xx exponential backoff 1/2/4/8/16s; per FR-022 fail-fast on 4xx. Test T164 + T165 GREEN.
- [ ] T169 [US6] Implement cron handler `src/app/api/cron/broadcasts/dispatch-scheduled/route.ts` — Bearer auth via `CRON_SECRET`. Calls Application `dispatch-scheduled-broadcast.ts`. Batches of 10 broadcasts per run. Runtime budget ≤4 min per perf.md CHK032.
- [ ] T170 [US6] Configure cron-job.org schedule for `/api/cron/broadcasts/dispatch-scheduled` (5-min cadence) — document in `docs/runbooks/cron-jobs.md`.
- [ ] T171 [US6] Implement edge-case handler for `broadcast_sent_with_expired_member_plan` (US6 AS5) — when cron picks up broadcast but member's plan no longer entitled, dispatch anyway (entitlement was confirmed at submit/approve) but emit audit event for admin observability.
- [ ] T171a [US1] Implement draft-expiry cleanup cron at `src/app/api/cron/broadcasts/prune-expired-drafts/route.ts` (FR-001a — Ambiguity A1 resolution from /speckit.analyze). Bearer auth via `CRON_SECRET`. Daily cadence via cron-job.org (separate from 5-min dispatch cron). Deletes `broadcasts WHERE status='draft' AND updated_at < NOW() - INTERVAL '30 days'`. NO audit event (drafts are user scratch space). Returns count of pruned rows for observability. Document in `docs/runbooks/cron-jobs.md`.

**Checkpoint US6**: Scheduled future-dated sends work via cron-job.org 5-min trigger. Concurrent-worker idempotency guaranteed.

---

## Phase 9: Cross-cutting Observability + Security + Compliance

**Purpose**: Wire all metrics + alerts + traces + log redactions + secret rotations + DPIA + Vercel platform redaction. Required before /speckit.review per Constitution Principle VII.

- [ ] T172 [P] Wire OTel metrics in `src/modules/broadcasts/infrastructure/metrics.ts` — all 16 metrics from plan.md § Constitution Principle VII Metrics list. Backed by `@vercel/otel`. Sample rates per perf.md CHK049 (100% for metrics, 100% webhook events, 10% prod traces / 100% dev/staging via `parentbased_traceidratio`). Errors + slow-path requests >1s at 100% via tail-sampler.
- [ ] T173 [P] Wire 11 alert rules in `docs/observability.md § F7 alerts` — table per plan.md § Performance & Capacity deep-dive > Observability + Plan § Constitution Principle VII Alerts. Wire via Datadog / Vercel Observability dashboard (configuration in repo via `.observability/` directory — stub if not yet provisioned).
- [ ] T174 [P] Wire distributed trace spans in Application + Infrastructure layers per Plan § Performance & Capacity deep-dive > Observability > Distributed trace span set (CHK047). 6 root spans + child spans documented in code-block format.
- [ ] T175 [P] Extend `src/lib/logger.ts` redact list with F7 forbidden fields per FR-042: `recipient_email`, `recipient_emails`, `body_html`, `subject` (when logging broadcast contents — only event-id + counts logged), `RESEND_BROADCASTS_API_KEY`, `RESEND_BROADCASTS_WEBHOOK_SECRET`, `UNSUBSCRIBE_TOKEN_SECRET`, `Resend-Signature`, `Authorization`, full webhook body. Recipient lists logged as count + first-3-hashes per Plan § Performance & Capacity deep-dive > Log redaction.
- [ ] T176 [P] Configure Vercel project log redaction per privacy.md CHK048 + Plan § Constitution Principle VII Vercel platform-layer log redaction verification — mask `/unsubscribe/v1\..*` URL path component in access logs UI + log-drain export. If Vercel does not support per-path redaction, document the absence in `docs/observability.md § F7 platform-redaction-limitation` + add quarterly `UNSUBSCRIBE_TOKEN_SECRET` rotation per Plan secret-rotation table.
- [ ] T177 [P] Document secret-rotation procedures in `docs/runbooks/credential-compromise.md` per Plan § Performance & Capacity deep-dive > Secret-rotation table. 4 secrets covered: `RESEND_BROADCASTS_API_KEY` (quarterly), `RESEND_BROADCASTS_WEBHOOK_SECRET` (annually), `UNSUBSCRIBE_TOKEN_SECRET` (annually + quarterly if CHK048 unavailable), `CRON_SECRET` (annually cross-feature).
- [ ] T178 [P] Document GDPR Art. 17 erasure cascade per data-model.md § GDPR Art. 17 erasure cascade — when F3 member row erased: `broadcasts.requested_by_member_id` SET NULL; `broadcast_deliveries.recipient_member_id` SET NULL; `marketing_unsubscribes.member_id` SET NULL but row preserved (indefinite retention). Implement in F3 cascade hooks (extends F3 erasure use case).
- [ ] T178a [P] Implement F3 archival/erasure auto-cancel cascade for in-flight broadcasts (Spec § Edge Cases L353 — Coverage Gap C2 from /speckit.analyze). When F3 member is archived OR GDPR-erased AND member has broadcasts WHERE `status IN ('submitted','approved')`: auto-cancel each in-flight broadcast with `cancellation_reason = 'originator_member_deleted'` + release quota reservation per FR-003 + audit `broadcast_cancelled` with `actor_role = 'system'` and `cancelled_by_user_id = NULL` (system-initiated). Implementation: extend F3 archival/erasure use case to call F7 barrel export `cancelInFlightBroadcastsForMember(tenantCtx, memberId, reason): Result<void, CascadeError>` (NEW barrel export). Integration test `tests/integration/broadcasts/member-erasure-cascade.test.ts`: seed member with 2 submitted + 1 approved broadcast → trigger F3 archival → assert all 3 transition to `cancelled` + 3 audit events emitted + reservations released.
- [ ] T179 [P] Implement `tests/integration/broadcasts/jcc-test-tenant-fixture.test.ts` (Q18 / SC-011 per-release multi-tenant readiness) — CI-nightly job that creates JCC-test tenant, seeds default segments, configures Resend test-mode account stub, submits + approves + dispatches synthetic broadcast, verifies cross-tenant isolation + tenant-scoped audit + tenant-scoped metrics, tears down. Total runtime <5 min. Failure = ship blocker.
- [ ] T180 [P] Create `.github/workflows/multi-tenant-readiness.yml` — runs T179 nightly. Posts status badge.
- [ ] T181 [P] Implement CI synthetic load script `scripts/synthetic-load-broadcasts.ts` per perf.md CHK065 — exercises 5 critical paths (compose TTFB / submit / queue list at 1k rows / approve send-now / webhook). Asserts p95 budgets per SC-010. PR fails if p95 >10% over budget.
- [ ] T182 [P] Wire `next-bundle-analyzer` JS bundle budgets per perf.md CHK038 — fails build if any route exceeds budget (compose ≤180 KB / queue ≤120 KB / detail ≤100 KB / benefits ≤80 KB / unsubscribe ≤30 KB).
- [ ] T183 [P] Create DPIA stub `docs/compliance/dpia-template.md` (privacy.md CHK054) + populate `docs/compliance/processing-records.md § F7` (privacy.md CHK055).
- [ ] T184 [P] Implement Application audit emitter in `src/modules/broadcasts/infrastructure/audit/broadcasts-audit.ts` — emits all 37 event types from FR-033. Each event has structured payload (member_id + broadcast_id + actor_role + segment + counts; NEVER raw recipient emails / body / subject per FR-034). Map each event type to `retention_years = 5` per migration 0069.
- [ ] T185 [P] Wire audit-log query for compliance officer per privacy.md CHK034 — admin-role can read F7 audit events (deferred to F9 audit-viewer surface but the query helper is exposed via F7 module barrel for F9 to consume).

---

## Phase 10: Polish + Quality Gates + Retrospective

**Purpose**: Final i18n + a11y + security + perf + retrospective before `/speckit.verify` + `/speckit.review` gates.

### i18n + a11y polish

- [ ] T186 [P] Verify `pnpm check:i18n` passes — every key in `en.json` present in `th.json` + `sv.json`. Estimated ~200 new keys × 3 locales = ~600 entries.
- [ ] T187 [P] Implement `pnpm check:i18n --orphans` flag per i18n.md CHK054 — extends `scripts/check-i18n-coverage.ts`.
- [ ] T188 [P] Implement static-key invariant ESLint rule per i18n.md CHK053 — forbid template-literal / variable-interpolation in `t()` calls. Static `ERROR_KEY_MAP as const satisfies Record<...>` pattern for error-code mapping.
- [ ] T189 [P] Chamber TH/SV liaison reviews legally-precise strings per i18n.md CHK041 — Q15 banner copy + PDPA notices + footer unsubscribe CTA. JSON-diff workflow: maintainer adds EN + placeholder TH/SV → liaison reviews via PR comment → liaison commits final TH/SV strings.
- [ ] T190 [P] Run automated `@axe-core/playwright` scan on every F7 surface (compose / queue / detail / benefits / 3 banners / dialogs / unsubscribe page) per a11y.md CHK055.
- [ ] T191 Manual screen-reader QA pass per a11y.md CHK056 — NVDA + VoiceOver covering compose flow + admin approve flow + banner acknowledge flow + unsubscribe flow. Recipient: chamber-os-ux-architect + mobile-a11y-ux-reviewer agents staff-review.
- [ ] T192 [P] Implement Tiptap zoom 200% Playwright test `tests/e2e/broadcast-a11y.spec.ts > tiptap-zoom-200` per a11y.md CHK006 + i18n.md CHK006.
- [ ] T193 [P] Implement `<html lang>` + `<span lang="auto">` Playwright tests `tests/e2e/broadcast-a11y.spec.ts > html-lang-attribute-correct-per-resolved-locale` per i18n.md CHK065.
- [ ] T194 [P] Implement `prefers-reduced-motion` Playwright tests `tests/e2e/broadcast-a11y.spec.ts > reduced-motion` per a11y.md CHK058 — verifies 7-row reduced-motion matrix.
- [ ] T195 [P] Implement TH IME composition Playwright test `tests/e2e/broadcast-i18n.spec.ts > tiptap-th-ime-composition` per i18n.md CHK059.
- [ ] T196 [P] Implement TH+EN+SV dispatch round-trip Playwright test `tests/e2e/broadcast-i18n.spec.ts > resend-dispatch-roundtrip` per i18n.md CHK032 — TH-only subject + bidirectional + emoji-bearing subjects.
- [ ] T197 [P] Implement length-expansion Playwright test `tests/e2e/broadcast-i18n.spec.ts > localised-layout-survives-th-expansion` per i18n.md CHK056 — switches to TH locale, navigates each F7 surface, asserts no overflow + no horizontal scroll at 320px + 1280px.

### Security + compliance polish

- [ ] T198 Run `security-threat-modeler` agent pass per Plan § Constitution Principle IX solo-maintainer substitute (e). Reviews HTML-sanitisation XSS surface + token-forgery surface + webhook signature surface.
- [ ] T199 Run `pdpa-gdpr-compliance-officer` agent pass per Plan § Constitution Principle IX solo-maintainer substitute (d). Reviews marketing-consent + unsubscribe surface + DSR coverage.
- [ ] T200 Verify SAQ-A scope unchanged — F7 has no payment surface; PCI scope unaffected (Plan § Constitution Principle IV N/A).
- [ ] T201 Verify F4 audit retention NOT impacted — F7 events default to 5y retention (NOT 10y tax-document overlap) per migration 0069.
- [ ] T202 Verify cross-tenant suppression isolation per FR-018 + Q19 + JCC-test fixture — same person unsubscribed in tenant A is still deliverable in tenant B.
- [ ] T203 Run `pnpm audit --prod` — fails on HIGH/CRITICAL. Sanitiser + Tiptap + email-validator are security-critical components per Plan § Constitution OWASP A06.

### Performance polish

- [ ] T204 [P] Run perf benchmark suite — verify SC-010 budgets met at 5k member fixture: compose TTFB <600ms / submit <1.2s / queue <500ms / approve <1.5s / webhook <250ms / unsubscribe <400ms. Capture results in `specs/010-email-broadcast/perf-benchmarks.md`.
- [ ] T205 [P] Verify suppression lookup batched as single `WHERE email = ANY($1)` per perf.md CHK028 + CHK058 — `EXPLAIN ANALYZE` integration test.
- [ ] T206 [P] Verify custom-list validation as single CTE per perf.md CHK029 — `EXPLAIN ANALYZE` integration test.
- [ ] T207 [P] Verify segment resolver index `(tenant_id, plan_id) INCLUDE (primary_contact_email, member_id)` per perf.md CHK025 — sub-50ms p95 at 5k members + 5k suppressions.
- [ ] T208 [P] Verify RLS overhead ≤5ms p95 per perf.md CHK024 — `EXPLAIN ANALYZE` 5 hottest queries.
- [ ] T209 [P] Verify TanStack Table virtualization at >100 rows per perf.md CHK039 — Playwright DOM-node-count assertion at 1k rows.

### Final verification

- [ ] T210 Run full CI pipeline locally per CLAUDE.md: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1`. ALL GREEN required before /speckit.verify.
- [ ] T211 Verify Constitution v1.4.0 Principle I tenant-isolation Review-Gate blocker test `tests/integration/broadcasts/tenant-isolation.test.ts` GREEN.
- [ ] T212 Verify Constitution v1.4.0 Principle I clause 5 super-admin: NOT applicable to F7 (no super-admin console yet — F13 scope).
- [ ] T213 Verify quickstart.md walkthrough end-to-end against staging deployment.
- [ ] T214 Verify FR-039 + SC-006 i18n coverage 100% in EN + TH + SV — `pnpm check:i18n` GREEN.
- [ ] T215 Verify SC-010 per-surface p95 budgets met at production scale — capture RUM windows in retrospective.
- [ ] T216 Verify SC-011 multi-tenant readiness per-release invariant — JCC-test fixture passes.
- [ ] T217 Write retrospective `specs/010-email-broadcast/retrospective.md` per Plan § Constitution Principle IX solo-maintainer substitute evidence — capture: (a) `/speckit.review` ≥3 passes evidence, (b) `/speckit.staff-review` correctness+security+tests results, (c) `pdpa-gdpr-compliance-officer` agent pass, (d) `security-threat-modeler` agent pass, (e) DB-level RLS+FORCE + sanitiser-at-Application defence-in-depth verified, (f) post-remediation `/speckit.verify` results.
- [ ] T218 Update `CLAUDE.md` § Recent Changes — add F7 Email Broadcast (E-Blast) ship snapshot summary.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately.
- **Phase 2 (Foundational)**: Depends on Phase 1. **Blocks all user stories.** Tenant-isolation + kill-switch tests MUST be GREEN before any US starts.
- **Phase 3 (US1)** + **Phase 4 (US2)**: Depend on Phase 2. P1 priority — both required for MVP slice. May proceed in parallel by separate developers (US1 = member-facing; US2 = admin-facing).
- **Phase 5 (US3)** + **Phase 6 (US4)** + **Phase 7 (US5)**: Depend on Phase 2. P2 priority. May proceed in parallel after Phase 2.
- **Phase 8 (US6)**: Depends on Phase 4 (admin approve with schedule) + Phase 7 (webhook tracking). P3 priority.
- **Phase 9 (Cross-cutting)**: Depends on Phases 3+4 minimum. May start in parallel with Phases 5–8 once core implementation lands.
- **Phase 10 (Polish)**: Depends on all desired user stories complete.

### User Story Dependencies

- **US1 (P1, Member compose & submit)**: Foundation of the data model + state machine. Blocks US2 (no broadcasts to review) but otherwise independent.
- **US2 (P1, Admin review queue)**: Depends on US1 (broadcasts to review). MVP slice = US1 + US2.
- **US3 (P2, Member quota & history)**: Depends on US1 (broadcasts to display). Independent of US2 lifecycle.
- **US4 (P2, Public unsubscribe)**: Independent of US1/US2 broadcast lifecycle but uses email footer wired in US4 itself; needs broadcast email to ship for end-to-end test.
- **US5 (P2, Webhook delivery tracking)**: Depends on US2 (broadcasts must reach `sending` for webhooks to fire). Webhook event ingestion + quota consumption at `sending → sent`.
- **US6 (P3, Scheduled cron dispatch)**: Depends on US2 (admin approve with schedule mode) + US5 (webhook propagation after dispatch).

### Within Each User Story

- RED tests committed FIRST (TDD discipline NON-NEGOTIABLE per Constitution Principle II).
- Domain → Application → Infrastructure → Presentation order.
- Use case → API endpoint → UI component order within each layer.

### Parallel Opportunities

- All Phase 1 tasks marked [P] can run in parallel (T002–T008 + T010).
- All Phase 2 migrations (T012–T018) can run in parallel after T011 establishes the schema.ts file.
- All Phase 2 ports + value-objects + invariants + policies (T024–T028) can run in parallel.
- All US1 RED tests (T036–T056) can run in parallel.
- All US1 component files marked [P] (T081–T090) can run in parallel.
- All US2 component files marked [P] (T117–T123) can run in parallel.
- All US3/US4/US5/US6 phases can run in parallel after Phase 2 complete (if multiple developers).
- All Phase 9 cross-cutting tasks (T172–T185) can run in parallel.
- All Phase 10 polish tasks marked [P] can run in parallel.

---

## Parallel Example: User Story 1 RED tests (Phase 3)

```bash
# Launch all RED tests for US1 in parallel — TDD discipline:
Task: "RED contract test tests/contract/broadcasts/post-broadcasts-draft.contract.test.ts"
Task: "RED contract test tests/contract/broadcasts/post-broadcasts-submit.contract.test.ts"
Task: "RED unit test tests/unit/broadcasts/domain/broadcast-state-machine.test.ts"
Task: "RED unit test tests/unit/broadcasts/domain/quota-counter.test.ts"
Task: "RED unit test tests/unit/broadcasts/domain/email-lower.test.ts"
Task: "RED unit test tests/unit/broadcasts/application/sanitize-html.test.ts"
Task: "RED unit test tests/unit/broadcasts/application/validate-custom-recipients.test.ts"
Task: "RED unit test tests/unit/broadcasts/application/resolve-segment-recipients.test.ts"
Task: "RED unit test tests/unit/broadcasts/application/submit-broadcast.test.ts"
Task: "RED integration test tests/integration/broadcasts/html-sanitiser.test.ts"
Task: "RED integration test tests/integration/broadcasts/audience-cap.test.ts"
Task: "RED integration test tests/integration/broadcasts/halt-flag-precondition.test.ts"
Task: "RED E2E test tests/e2e/broadcast-compose-and-submit.spec.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2 only)

1. Complete Phase 1 (Setup) — T001–T010.
2. Complete Phase 2 (Foundational) — T011–T035. Tenant-isolation + kill-switch tests GREEN.
3. Complete Phase 3 (US1 — Member compose & submit) — T036–T092. RED tests first, then Domain → Application → Infrastructure → API → UI → i18n.
4. Complete Phase 4 (US2 — Admin review queue) — T093–T126. Same TDD pattern.
5. **STOP and VALIDATE**: full end-to-end test — member submits, admin approves, transactional emails fire, audit log complete.
6. Deploy/demo MVP slice. **F7 delivers the paid benefit at this point.**

### Incremental Delivery

1. MVP (US1+US2) → Test independently → Deploy/Demo (P1 done).
2. Add US3 (Member quota & history) → Test → Deploy. Members can self-serve quota questions (P2 #1 done).
3. Add US4 (Public unsubscribe) → Test → Deploy. Regulatory requirement met (P2 #2 done — GDPR Art. 21 + PDPA §24 + ePrivacy).
4. Add US5 (Webhook delivery tracking) → Test → Deploy. Quota consumption now tied to actual delivery (P2 #3 done).
5. Add US6 (Scheduled cron dispatch) → Test → Deploy. Marketing send-time control delivered (P3 done).
6. Phase 9 (Cross-cutting observability + security) lands in parallel with Phases 5–8.
7. Phase 10 (Polish + Quality Gates + Retrospective) before /speckit.verify + /speckit.review.

### Solo-maintainer Strategy

Per Plan § Constitution Principle IX solo-maintainer substitute, with no second human reviewer:
1. After each story's implementation lands, run `/speckit.review` (≥3 passes with decreasing severity).
2. After all 6 stories done, run `/speckit.staff-review` (correctness + security + tests agents).
3. If any BLOCKER/CRITICAL: remediate + re-run `/speckit.staff-review` second post-remediation round.
4. Run `pdpa-gdpr-compliance-officer` agent pass (T199).
5. Run `security-threat-modeler` agent pass (T198).
6. Verify DB-level RLS+FORCE + sanitiser-at-Application defence-in-depth (T211 + T203).
7. Post-remediation `/speckit.verify`.
8. Capture evidence in retrospective (T217).

---

## Notes

- [P] tasks = different files, no blocking dependencies.
- [Story] label maps task to specific user story for traceability.
- TDD discipline NON-NEGOTIABLE per Principle II — RED tests committed before implementation.
- `pnpm test:e2e --workers=1` mandatory per user feedback memory (default workers=3 hangs the dev machine).
- F7 events default to 5-year audit retention (NOT tax-document overlap with F4's 10y).
- Stable Resend idempotency key per FR-020: `broadcast-{tenantId}-{broadcastId}` — NO attempt counter (R2-NEW-1 fix).
- Image extension MUST stay disabled in Tiptap config per R2-NEW-1 — cross-checked at /speckit.verify.
- Banner-stacking-aligned roles per Plan § Banner scope and stacking — 3 banners are mutually exclusive on any single page.
- F6 EventAttendees stub returns `[]` until F6 ships; both features release together in Phase 2 batch.
- Solo-maintainer substitute applies if no second human reviewer available — evidence in retrospective.
- F7 GATE 4 sensitive-feature checklist coverage: privacy ✅ + security ✅ + ux ✅ + a11y ✅ + i18n ✅ + perf ✅ — **6/6 with 0 open gaps**.
