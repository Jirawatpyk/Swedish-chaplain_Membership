# Tasks: Member Portal — Approval Workflow for Member Changes

**Input**: Design documents from `/specs/114-member-change-approval/`
**Prerequisites**: plan.md, spec.md (6 user stories, 40 FRs), research.md (R1–R18, V1–V4), data-model.md, contracts/ (3), quickstart.md, checklists/ (7)

**Tests**: REQUIRED — Constitution Principle II (TDD, NON-NEGOTIABLE). Every story phase starts with tests that MUST fail before the implementation tasks run. Tenant isolation, concurrency, decision rollback, erasure scrub and the rate cap need **live-Neon integration tests** (dev branch), not mocks. Coverage pins: Domain 100 % lines; the six security-critical use cases + the gate resolver 100 % branches (`vitest.config.ts`, T105).

**Commits**: commit RED after each story's tests block (`[Spec Kit] F114 USn tests (red)`), commit GREEN after each implementation task or logical group; Conventional Commits enforced by the hook; `pnpm typecheck` + full `pnpm lint` before every commit (neither is in a gate). Never `git add -A`; never `git stash` on this checkout. T115–T118 were added by `/speckit.superb.review` and T119 by `/speckit.analyze` (round 1); round 2 dropped the `[P]` marker from T015 and T116 (same-file edits). Each added task sits inside the phase it belongs to, so IDs are not in file order for those five.

**Organization**: Tasks are grouped by user story. Delivery is three PRs, each independently reviewable and dark behind `FEATURE_MEMBER_CHANGE_APPROVAL` (default OFF): **PR-1** = Phases 1–5 (foundation + US1 + US2 + US3 — the complete submit → decide → resubmit loop, which is the smallest shippable increment because a held request nobody can decide has no value); **PR-2** = Phases 6–7 (US4 history + US5 withdraw/replace/cap); **PR-3** = Phases 8–9 (US6 tenant switch + dashboard, polish, cutover). The tenant switch is flipped ON for SweCham only after PR-3.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US6 from spec.md
- File paths are repository-relative. Migrations are hand-written SQL registered in `drizzle/migrations/meta/_journal.json` (next: tag `0300_member_change_requests`, `idx 301`, `when 1798543200000` — the last entry is `0299` at `1798543100000`; +100000 per file, a duplicate `when` makes `db:migrate` a silent no-op). Never run `db:generate`. Apply with `pnpm db:migrate` (dev branch) and verify via `information_schema` before committing.

## Path Conventions

Modular monolith: `src/modules/members/{domain,application,infrastructure}`, presentation in `src/app/(member)/portal/**` + `src/app/(staff)/admin/**` + `src/app/api/**`, composition in `src/lib/**`, tests in `tests/{unit,contract,integration,e2e}/**`. Cross-module imports only through barrels. File-mutating agents run sequentially; read-only reviewers may run concurrently.

---

## Phase 1: Setup

**Purpose**: Branch hygiene, the platform flag, and the two unflagged UI-shape changes that every later phase reuses.

- [x] T001 Confirm branch `114-member-change-approval` is current (`git branch --show-current`), rebase on `main`, and confirm `drizzle/migrations/meta/_journal.json` still ends at tag `0299_broadcasts_audience_import_coherence` / `when 1798543100000` (renumber the plan's `0300` / `1798543200000` if another branch landed first) — **done 2026-09-11**: branch current, `origin/main` had no new commits, journal ended at `0299` / `1798543100000` as planned
- [x] T002 Add `FEATURE_MEMBER_CHANGE_APPROVAL` (zod boolean, default `false`) to `src/lib/env.ts`, document it in `.env.example` with the default, and confirm `pnpm check:env-example` + `pnpm check:env-boot` pass — **done 2026-09-11**: `check:env-example` OK (75 keys) + `check:env-boot` OK
- [x] T003 [P] Create `specs/114-member-change-approval/reviews/README.md` listing the reviewer agents per PR (security-engineer, pdpa-gdpr-compliance-officer, reliability-guardian, drizzle-migration-reviewer, enterprise-ux-designer, thai-tax-compliance-auditor, whole-branch-reviewer) and the Constitution v1.4.2 co-sign footer template for `checklists/{security,privacy,ux,reliability,operations,tax}.md`
- [x] T004 [P] Promote `src/components/broadcast/reason-confirmation-dialog.tsx` to `src/components/shell/reason-confirmation-dialog.tsx` (props unchanged: `open, onOpenChange, namespace, maxLength, reasonRequired, fieldIdPrefix, textareaRows, onConfirm, finalFocus`), leave a re-export at the old path, and confirm `tests/unit/broadcast/**` + `tests/unit/broadcasts/**` still pass (two folders, one letter) — **done 2026-09-11**: `git mv` + a re-export at the old path; `tests/unit/broadcast(s)/**` untouched (dialog-final-focus test imports the old path)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The verify-before-task facts (research V1, V3, V4), the migration, the enum widenings, the Domain model, the ports, the repo, the gate resolver and the composition — everything every story needs.

**⚠️ CRITICAL**: No user story work can begin until T028 is green. V2 (gauges cron host) is in Phase 8 because only US6 needs it.

- [x] T005 **V1** Read `buildMemberFormSchema` (staff member form) and the portal `hasDangerousUrlScheme` refine in `src/modules/members/application/use-cases/member-self-update.ts`; record in `research.md § V1` which website rule is canonical for Group B (the parity test T018 asserts reference-equality to it), and whether the staff edit path enforces company-name uniqueness anywhere (zod, repo or DB) — if it does, T036 and T051 MUST call that same check (spec § Edge Cases "Company name identical to another member's") — **done 2026-09-11**: recorded in `research.md § V1` — canonical rule = the SERVER staff schemas; parity is reference-equality via shared `field-rules.ts` objects; NO company-name uniqueness exists on any staff path
- [x] T006 **V3** Read `src/app/api/cron/outbox-dispatch/route.ts` around the `receipt_pdf_render` arm (`runInTenant(payload.tenantId)`) and record in `research.md § V3` how a dispatcher arm obtains a tenant tx to read `member_change_requests` at send time (R8 read-at-send). Decision rule: the two new arms (T037, T053) MUST read under `runInTenant(payload.tenantId)` exactly as the `receipt_pdf_render` arm does; copying the field diff into `context_data` is NOT an allowed fallback (privacy checklist CHK006/CHK011 — a sent outbox row must never hold names, phones or addresses) — **done 2026-09-11**: recorded in `research.md § V3`
- [x] T007 **V4** Run a read-only prod count (`--env-file=.env.production` + dummy secret, tsx with `TSX_TSCONFIG_PATH=tsconfig.scripts.json`): contacts with `linked_user_id IS NOT NULL AND is_primary = false`, and members with a billing address set; record both in `research.md § V4` (expected 0 secondaries with login — tests must seed them) — **done 2026-09-11**: recorded in `research.md § V4` — prod: 0 secondaries with login, 0 billing addresses, 150 members, 3 reviewers
- [x] T008 Write migration `drizzle/migrations/0300_member_change_requests.sql` (hand-written SQL, one statement per `--> statement-breakpoint`): (a) `CREATE TABLE member_change_requests` with columns `id uuid PK DEFAULT gen_random_uuid()`, `tenant_id text NOT NULL`, `member_id uuid NOT NULL`, `submitted_by_user_id uuid NOT NULL`, `submitted_by_contact_id uuid NOT NULL`, `submitter_role_at_submission text NOT NULL CHECK IN ('primary','secondary')`, `scope text NOT NULL CHECK IN ('company','own_contact','mixed')`, `state text NOT NULL CHECK IN ('pending','decided','withdrawn')`, `outcome text NULL CHECK IN ('approved','partially_approved','rejected')`, `withdrawn_reason text NULL CHECK IN ('member','replaced','erasure')`, `replaced_by_request_id uuid NULL`, `submitted_at timestamptz NOT NULL DEFAULT now()`, `staff_notified_at timestamptz NULL`, `decided_at`, `decided_by_user_id uuid NULL`, `decision_reason text NULL CHECK (char_length BETWEEN 1 AND 1000)`, `decision_note text NULL CHECK (char_length <= 1000)`, `withdrawn_at`, `outcome_acknowledged_at timestamptz NULL`, `created_at`/`updated_at`; composite FK `(tenant_id, member_id)` → `members`; CHECKs `(state = 'decided') = (outcome IS NOT NULL)`, `(state = 'decided') = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)`, `(state = 'withdrawn') = (withdrawn_reason IS NOT NULL)`; (b) `CREATE TABLE member_change_request_fields` with `id uuid PK`, `tenant_id text NOT NULL`, `request_id uuid NOT NULL REFERENCES member_change_requests(id) ON DELETE CASCADE`, `field_key text NOT NULL CHECK IN ('first_name','last_name','phone','role_title','company_name','website','description','registered_address','billing_address')`, `target text NOT NULL CHECK IN ('member','contact')`, `seen_value jsonb NULL`, `proposed_value jsonb NULL`, `outcome text NULL CHECK IN ('approved','rejected')`, `applied_at timestamptz NULL`, `affects_tax_documents boolean NOT NULL`, `UNIQUE (request_id, field_key)`; (c) indexes `member_change_requests_one_pending_per_submitter UNIQUE (tenant_id, submitted_by_user_id) WHERE state = 'pending'`, `(tenant_id, state, submitted_at DESC)`, `(tenant_id, member_id, submitted_at DESC)`, `(tenant_id, submitted_by_user_id, submitted_at)`, `(tenant_id, request_id)` on fields; (d) `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation_on_<table> … TO chamber_app USING (tenant_id = current_setting('app.current_tenant', TRUE)) WITH CHECK (same)` on both (0209 pattern); (e) `ALTER TABLE tenant_member_settings ADD COLUMN member_change_approval_enabled boolean NOT NULL DEFAULT false`; (f) five `ALTER TYPE audit_event_type ADD VALUE` statements (`member_change_request_submitted`, `member_change_request_decided`, `member_change_request_withdrawn`, `member_change_request_rate_limited`, `member_change_approval_setting_changed`) and two `ALTER TYPE notification_type ADD VALUE` (`member_change_request_submitted_staff`, `member_change_request_decided_member`) — each ADD VALUE in its own statement, ending with `;`, not on a `--` line (0292/0295 pattern) — **done 2026-09-11**: DDL split into TWO files per the repo's enum-only convention (0292/0295 headers): `0300_member_change_requests.sql` (tables, indexes, RLS, column) + `0301_member_change_request_enums.sql` (the 7 `ADD VALUE`s). Deviation from data-model § 6 "same migration": the `replaced_by_request_id` self-FK is `DEFERRABLE INITIALLY DEFERRED` — the replace path must close the old row WITH the pointer before the new row exists (the partial unique index forbids the other order); the `ON DELETE CASCADE` on the member + contact FKs is documented in the file header
- [x] T009 Register `0300_member_change_requests` in `drizzle/migrations/meta/_journal.json` (`idx 301`, `version "7"`, `when 1798543200000`, `breakpoints true`); run `pnpm db:migrate` against the dev branch; verify via `information_schema.tables/columns` + `pg_policies` + `pg_enum` that both tables, the column, the policies and all seven enum values landed; run `pnpm db:verify` — **done 2026-09-11**: journal `idx 301/302`, `when 1798543200000/1798543300000`; applied to dev; verified via `information_schema` + `pg_policies` + `pg_class` + `pg_enum` + `pg_constraint` (2 tables, 21+10 columns, RLS+FORCE, 2 policies, 8 indexes, 7 enum values, all CHECKs/FKs); `pnpm db:verify` green
- [x] T010 Add both tables to `SCOPED_TABLES` in `scripts/check-multi-tenant*.ts` and confirm `pnpm check:multi-tenant` passes against the dev branch — **done 2026-09-11**: `check:multi-tenant` — 28 scoped tables OK
- [x] T011 [P] Create `src/modules/members/infrastructure/db/schema-change-requests.ts` (Drizzle `pgTable`s `memberChangeRequests`, `memberChangeRequestFields` mirroring T008 exactly; inferred types stay in this file) and add `memberChangeApprovalEnabled: boolean('member_change_approval_enabled').notNull().default(false)` to `src/modules/members/infrastructure/db/schema-member-settings.ts`
- [x] T012 [P] Add the five event names to `AUDIT_EVENT_TYPES` in `src/modules/auth/domain/audit-event.ts`, to `auditEventTypeEnum` in `src/modules/auth/infrastructure/db/schema.ts`, and bump the pinned count `toHaveLength(37)` → `42` in `tests/unit/auth/domain/audit-event.test.ts` (+ any other count pin `pnpm check:audit-events` reports) — **done 2026-09-11**: `AUDIT_EVENT_TYPES` 37 → 42, `auditEventTypeEnum` +5, `REQUIRED_ENUM_VALUES` (enum-migration-guard) +5 audit +2 notification
- [x] T013 [P] Extend the F3 `AuditEventType` union in `src/modules/members/application/ports/audit-port.ts` with the five events (payload comments per `contracts/notifications-and-audit.md` § 2: `member_id` on submit/withdraw-by-member, `related_member_id` on decide/replaced/erasure — never values) — **done 2026-09-11**: + `f3-audit-event-type-count.test.ts` tuple 37 → 42
- [x] T014 [P] Add `audit.eventType.member_change_request_{submitted,decided,withdrawn,rate_limited}` + `member_change_approval_setting_changed` labels to `src/i18n/messages/{en,th,sv}.json` (Thai script in `th`); confirm `tests/unit/insights/audit-event-label-coverage.test.ts` and `pnpm check:i18n` pass — **done 2026-09-11**: label-coverage test + `check:i18n` (5,261 keys) green
- [x] T015 Add (after T012 — same file `src/modules/auth/infrastructure/db/schema.ts`) `member_change_request_submitted_staff` and `member_change_request_decided_member` to `notificationTypeEnum` in `src/modules/auth/infrastructure/db/schema.ts`, to `EmailNotificationType` in `src/modules/members/application/ports/email-port.ts`, and to the adapter switch in `src/modules/members/infrastructure/adapters/resend-email-port.ts` (enqueue only — rendering arms come in US1/US2) — **done 2026-09-11**: the members `resend-email-port.ts` has no per-type switch (it inserts `request.type` verbatim) — nothing to add there; the two rendering arms come in T037/T053
- [x] T016 Write RED unit tests `tests/unit/members/change-requests/domain-policies.test.ts` for the Domain: `deriveOutcome` (all/some/none approved → `approved`/`partially_approved`/`rejected`), `deriveScope` (company keys require primary → `company_fields_require_primary`; mixed), `diffAgainstRecord` (drops equal values; address groups atomic; null = clear), `affectsTaxDocuments` (company_name, billing_address always; registered_address iff no billing address; first_name/last_name iff submitter is primary), `changedSinceSubmitted` (deep-equal for address objects); plus `PROPOSABLE_FIELD_KEYS` tuple parity with the T008 CHECK list
- [x] T017 Implement the Domain in `src/modules/members/domain/change-request/change-request.ts` (types from `data-model.md` § 7: `ChangeRequestState`, `ChangeRequestOutcome`, `WithdrawnReason`, `FieldOutcome`, `ProposedField`, `ChangeRequest`), `src/modules/members/domain/change-request/proposable-fields.ts` (`PROPOSABLE_FIELD_KEYS` as const + target map + tax map + `REGISTERED_ADDRESS_LINES` / `BILLING_ADDRESS_LINES`), and `src/modules/members/domain/change-request/policies.ts` (pure; no framework imports) — T016 green
- [x] T018 Write RED unit test `tests/unit/members/change-requests/field-rules-parity.test.ts` asserting, per Group B key, that the rule exported by `field-rules.ts` is reference-equal to the staff form's rule (`buildMemberFormSchema` shape / contact schema / `asPhone`) per V1 — **done 2026-09-11**: reference-equality on `updateMemberSchema` (unwrapped `ZodEffects`) + `updateContactFieldsSchema` shape entries
- [x] T019 Implement `src/modules/members/domain/change-request/field-rules.ts` (per-key zod rule taken from the staff form + `asPhone`; address groups validated as objects; export `validateProposal(fields)` returning `ZodIssue[]`) — T018 green — **done 2026-09-11**: `update-member.ts` + `contact-crud.ts` now BUILD their Group B entries from `field-rules.ts` (the mechanism R14 asked for); `member-form/schema.ts` imports `normalizeWebsiteUrl` from the same module
- [x] T020 Split `src/modules/members/domain/portal-self-update-fields.ts` into `PORTAL_IMMEDIATE_CONTACT_FIELDS = ['preferredLanguage'] as const` (Group A) and keep the existing tuples as the flag-OFF set; extend `tests/unit/members/**/portal-self-update-fields*.test.ts` key-set parity to both sets — **done 2026-09-11**: `PORTAL_IMMEDIATE_CONTACT_FIELDS = ['preferredLanguage']` + `PORTAL_IMMEDIATE_MEMBER_FIELDS = []`; flag-OFF tuples untouched; parity test extended
- [x] T021 [P] Define the ports: `src/modules/members/application/ports/change-request-repo.ts` (`ChangeRequestRepo`: `insertInTx`, `findByIdInTx(tx, id) FOR UPDATE`, `findPendingBySubmitterInTx(tx, userId) FOR UPDATE`, `withdrawInTx(tx, id, reason, replacedById?)`, `decideInTx(tx, id, decision)`, `acknowledgeInTx`, `countSubmittedSince(tx, userId, since)`, `listQueue(ctx, filter, cursor)`, `listByMember`, `listVisibleToUser(ctx, userId, memberId)`, `pendingStats(ctx)` → `{count, oldestSubmittedAt}`), `src/modules/members/application/ports/reviewer-directory-port.ts` (`listReviewers(): {userId, email, locale}[]` = active users holding `members.write`), `src/modules/members/application/ports/change-request-scrub-port.ts` (`scrubForMemberInTx(tx, memberId)`) — **done 2026-09-11**: + `tenant-member-change-settings-port.ts` (the R11 switch, kept apart from the 055 prefix reader)
- [x] T022 Write RED integration test `tests/integration/members/change-requests-repo.test.ts` (live Neon dev branch): insert + fields round-trip; partial unique index refuses a second pending row for the same `(tenant_id, submitted_by_user_id)`; CHECKs refuse `state='decided'` without `outcome`; RLS FORCE — a `runInTenant` for tenant B sees zero rows of tenant A in both directions — **done 2026-09-11**: 8/8 on live Neon incl. RLS both directions + the DB CHECK refusal; `test-tenant.ts` cleanup gained the two tables
- [x] T023 Implement `src/modules/members/infrastructure/db/drizzle-change-request-repo.ts` (every method threads the caller's `tx`; never the global `db`; `FOR UPDATE` on the two `*InTx` reads; keyset pagination on `(submitted_at, id)`) — T022 green — **done 2026-09-11**: a failed statement leaves the tx ABORTED — callers roll back via `UseCaseAbort` (the existing contract); `acknowledgeInTx` is `COALESCE`-idempotent
- [x] T024 Write RED unit test `tests/unit/members/change-requests/resolve-member-change-gate.test.ts`: flag OFF → `immediate` regardless of the tenant row; flag ON + row absent → `immediate`; flag ON + `member_change_approval_enabled=true` → `approval`
- [x] T025 Implement `src/modules/members/application/use-cases/change-requests/resolve-member-change-gate.ts` (reads `env.FEATURE_MEMBER_CHANGE_APPROVAL` via a `FlagPort` + `tenant_member_settings` via a `TenantMemberSettingsPort`; per-request cache) — T024 green — **done 2026-09-11**: `makeMemberChangeGateResolver(deps).resolve(tenant)` with per-resolver cache; a settings read failure THROWS (never guesses a mode)
- [x] T026 [P] Create the shared test doubles `tests/helpers/change-request-fakes.ts` (in-memory `ChangeRequestRepo`, `ReviewerDirectoryPort` with N reviewers, `EmailPort` capturing enqueues, `AuditPort` capturing events, `ClockPort`) — every unit test from T029 on uses these; every port method has a double (an unstubbed method is an unexercised branch)
- [x] T027 [P] Add `membersMetrics.changeRequests` to `src/lib/metrics.ts`: gauges `members.change_requests_pending_count{tenant}`, `members.change_request_oldest_age_seconds{tenant}`; counters `members.change_request_submitted.total{tenant,scope,coalesced}`, `members.change_request_decided.total{tenant,outcome}`, `members.change_request_refused.total{tenant,reason ∈ rate_limited|forbidden|archived|already_decided|validation}`; histogram `members.change_request_decide_ms{tenant}` — **done 2026-09-11**: `membersMetrics.changeRequests.{pendingCount,oldestAgeSeconds,submitted,decided,refused,decideDurationMs}`
- [x] T028 Wire composition: `src/modules/members/members-deps.ts` gains `changeRequestRepo`, `changeRequestScrub`, `memberChangeGate`; create `src/lib/members-change-request-deps.ts` with the `ReviewerDirectoryPort` adapter over the auth `users` table (`status='active' AND role IN (admin, super_admin)` — the set holding `members.write` today, resolved through `hasPermission`, never a role literal) + unit test `tests/unit/lib/members-change-request-deps.test.ts`; export from the barrel `src/modules/members/index.ts` (Constitution III — presentation imports only via the barrel): `submitChangeRequest`, `withdrawChangeRequest`, `decideChangeRequest`, `acknowledgeChangeRequest`, `listChangeRequests`, `getChangeRequestReview`, `setMemberChangeApprovalEnabled`, `countPendingChangeRequests`, `resolveMemberChangeGate`, the Domain types from `domain/change-request/*` and `PROPOSABLE_FIELD_KEYS`; extend the members barrel guard in `tests/unit/architecture/` if one pins the export list — **done 2026-09-11**: `MembersDeps` += `changeRequestRepo`, `tenantMemberChangeSettings`, `memberChangeGate`; `src/lib/members-change-request-deps.ts` = `buildChangeRequestDeps` + `makeReviewerDirectory` (roles via `canPerform`, never a literal; `users` has no locale → platform default) + unit test; barrel += Domain/ports/gate/2 singletons (use-case exports land with each use case)

**Checkpoint**: migration applied and verified on dev; `pnpm check:multi-tenant`, `check:audit-events`, `check:i18n` green; Domain 100 % lines; repo integration test green; `pnpm typecheck` + `pnpm lint` clean. Commit `[Spec Kit] F114 foundation`.

---

## Phase 3: User Story 1 — Member submits a change; nothing is applied; staff are notified (Priority: P1) 🎯 MVP core

**Goal**: A Group B edit in the portal becomes a pending change request; the record is untouched; every reviewer gets one email with the field diff; Group A still saves immediately; the old immediate path is closed for Group B.

**Independent Test**: Primary contact submits phone + billing address → 201, record unchanged, pending banner shows both, each admin inbox gets one email with old → new values and a deep link; forged Group C key → 403 + `member_self_update_forbidden`; secondary submitting a company key → 403 `company_fields_require_primary`.

### Tests for User Story 1 (RED first) ⚠️

- [ ] T029 [P] [US1] Contract test `tests/contract/portal/change-requests-submit.test.ts` per `contracts/portal-change-requests-api.md` § 2: 201 `submitted` with `ChangeRequestView`; each Group C key → 403 `forbidden` + `member_self_update_forbidden` audit; `company` key from a secondary → 403 `company_fields_require_primary`; each US1 AS4 validation example → 422 `validation_error` with `issues`; equal payload → 200 `nothing_to_submit`; identical to pending → 200 `already_pending`; archived member → 403 `member_archived`; staff session → 403; flag OFF → 404; setting OFF → 409 `approval_not_required`; `Idempotency-Key` same body → stored response, different body → 422
- [ ] T030 [P] [US1] Contract test `tests/contract/portal/change-requests-gate.test.ts` (`GET …/gate`: `mode`, `canProposeCompanyFields` = `is_primary`, `pending` = caller's own only)
- [ ] T031 [P] [US1] Extend `tests/contract/portal/profile.test.ts`: with gate `approval`, `PATCH /api/portal/profile` accepts only `{ primary_contact: { preferredLanguage } }` and refuses each Group B key with 403 + `member_self_update_forbidden`; with gate `immediate` the existing assertions pass unchanged (SC-011)
- [ ] T032 [P] [US1] Unit test `tests/unit/members/change-requests/submit-change-request.test.ts` (100 % branches): diff → fields; scope derivation; validation refusal creates nothing; audit `member_change_request_submitted` payload `{ member_id, request_id, contact_id, scope, field_keys[], replaced_request_id: null, coalesced: false }` with `actorRole` = session role; one outbox row per reviewer with `context_data = { tenantId, requestId, memberId, submitterUserId, fieldKeys }` and `locale` = reviewer locale ?? tenant default; zero reviewers → request still created + `logger.warn`; metric `submitted.total{scope,coalesced=false}`
- [ ] T033 [P] [US1] Integration test `tests/integration/members/change-requests-tenant-isolation.test.ts` (Constitution I.3, SC-009): two tenants, one submission each; **reads** — `GET` history, `GET` gate, the staff queue, per-member history and the staff detail route from the other tenant see nothing / 404 in **both** directions; **writes** — from tenant B against tenant A's rows, `POST …/[id]/decide`, `DELETE …/current`, `POST …/[id]/acknowledge` and `PATCH /api/admin/settings/member-changes` (targeting A's setting row) all refuse (404/403), leave A's rows and setting untouched, and are audited as `member_cross_tenant_probe` — in **both** directions (Constitution I.3 requires reads AND writes)
- [ ] T034 [P] [US1] Integration test `tests/integration/members/change-requests-submit-atomicity.test.ts`: request + fields + audit + outbox rows commit together; an audit write failure (fault-injected `AuditPort`) rolls back the request and the outbox rows
- [ ] T035 [P] [US1] Unit test `tests/unit/members/infrastructure/change-request-submitted-staff-email.test.ts`: EN/TH/SV render; subject `[SweCham] Change request — <company> (<member no.>)`; one line per field `<label>: <current> → <proposed>` with `(empty)` for null and the tax marker on flagged rows; `escapeHtml` on every value; link `/admin/change-requests?submitter=<userId>&state=pending`; no CC/BCC

### Implementation for User Story 1

- [ ] T036 [US1] Implement `src/modules/members/application/use-cases/change-requests/submit-change-request.ts`: forged-field detection **before** parsing (reuse `detectForbiddenFields` semantics from `member-self-update.ts`, refuse + `member_self_update_forbidden`); primary check for company keys; `validateProposal` (T019); `diffAgainstRecord`; `deriveScope`; one `runInTenant`: `findPendingBySubmitterInTx` FOR UPDATE (replace path lands in US5 — here refuse `already_pending` when identical, else insert), `memberRepo.findByIdInTx` archived guard, `insertInTx`, `audit.recordInTx`, one `email.enqueueInTx` per reviewer from `ReviewerDirectoryPort` (`staffNotifiedAt = now`), throw-to-rollback (`UseCaseAbort`) on every failure after the first write; return `Result<{ request, replaced: null, staffNotified }>` — T032/T034 green
- [ ] T037 [US1] Implement `src/modules/members/infrastructure/email/change-request-submitted-staff-email.ts` (hand-built HTML like `email-verification-email.ts`; brand helpers; three locales) and the dispatcher arm `case 'member_change_request_submitted_staff'` in `src/app/api/cron/outbox-dispatch/route.ts` that reads the request + fields under the tenant tx (V3), renders the diff at send time, and marks the row skipped with `email_dispatch_failed { reason: 'request_gone' }` if the request row is missing — T035 green
- [ ] T038 [US1] Make `memberSelfUpdate` gate-aware in `src/modules/members/application/use-cases/member-self-update.ts`: input `gate: 'immediate' | 'approval'`; in `approval` mode the whitelist is `PORTAL_IMMEDIATE_CONTACT_FIELDS` only and any Group B key is refused with the existing `member_self_update_forbidden` audit; `immediate` mode is byte-identical to today — T031 green
- [ ] T039 [US1] Route handlers `src/app/api/portal/change-requests/route.ts` (`POST` submit — `requireMemberContext`, `parseIdempotencyKey` + `classifyIdempotencyRequest`/`reserveIdempotencyRecord`/`rememberIdempotentResponse` as `/api/portal/profile` does, 404 when the flag is off, 409 `approval_not_required` when the gate is `immediate`, `errorId` `M114.portal.submit.<arm>`) and `src/app/api/portal/change-requests/gate/route.ts` (`GET`) — T029/T030 green; pass `PATCH /api/portal/profile` the resolved gate (T038)
- [ ] T040 [US1] Portal edit page `src/app/(member)/portal/edit/page.tsx`: resolve the gate server-side; in `approval` mode render `src/components/members/change-requests/portal-change-request-form.tsx` (react-hook-form + zod from `field-rules.ts`; Group B fields only — company fields hidden for non-primary with the "contact your primary contact" note; the Art. 13 / PDPA § 23 notice with the privacy-notice link; inline `nothing_to_submit` / `already_pending` / 429 messages via `role="status"`; per-field server issues mapped back to fields; 320 px layout); in `immediate` mode keep `PortalEditForm` minus the language select; the language `<select>` is removed from both
- [ ] T041 [US1] Account page `src/app/(member)/portal/account/page.tsx`: add the contact's email/notification language (`contacts.preferred_language`, Group A) as a small form beside `PreferredLocaleForm`, posting `{ primary_contact: { preferredLanguage } }` to `PATCH /api/portal/profile`, with copy that distinguishes it from the display language
- [ ] T042 [US1] Pending banner `src/components/members/change-requests/pending-request-banner.tsx` (`role="status"`, submission time via `formatLocalisedDate`, proposed vs current via the shared read-only `src/components/members/change-requests/change-request-diff-table.tsx` — stacked cards < 640 px, address groups as one block, `(empty)` for null, tax marker by icon + text) rendered on `src/app/(member)/portal/profile/page.tsx` and on the edit page when a pending request exists
- [ ] T043 [US1] i18n keys for US1 in `src/i18n/messages/{en,th,sv}.json`: `portal.changeRequests.{form,notice,pending,status,errors}.*`, `portal.account.contactLanguage.*`, `email.changeRequest.submittedStaff.*` (subject/body/labels ×3); `pnpm check:i18n` green
- [ ] T044 [US1] e2e `tests/e2e/change-requests.spec.ts` (`@change-requests @a11y`, `--workers=1`, persona `e2e-member-empty` as primary + a seeded secondary): submit → banner → record unchanged in `/admin/members/[id]`; secondary sees no company fields; axe zero violations at 320 px on the edit page and profile banner

**Checkpoint**: US1 contract + unit + integration green; US1 e2e green locally; `member_self_update_forbidden` still fires for forged keys; commit `[Spec Kit] F114 US1 (green)`.

---

## Phase 4: User Story 2 — Staff approve in full or in part; approved fields apply everywhere at once; member is told (Priority: P1)

**Goal**: A reviewer decides per field in one action; approved fields are applied to `members`/`contacts` in the same transaction as the decision; both portals read the same record; the submitter is emailed the outcome; repeats and races are harmless.

**Independent Test**: Partial approval of phone (approve) + description (reject with reason) → both portals show the new phone and the old description; request `partially_approved` with reviewer/time/reason; one member email listing both; an identical repeat → 200 `repeated`, no second email/audit; manager → 403 on decide, 200 on read.

### Tests for User Story 2 (RED first) ⚠️

- [ ] T045 [P] [US2] Contract test `tests/contract/members/admin-change-requests-decide.test.ts` per `contracts/admin-change-requests-api.md` § 3: approve all → `approved`; some de-selected + reason → `partially_approved` with `applied`/`rejected` lists; `decisions` missing a field → 422 `decisions_incomplete`; rejected without reason → 422 `reason_required`; reason > 1000 → 422; identical repeat → 200 `repeated: true` (no second application/audit/email); different repeat → 409 `already_decided { decidedBy, decidedAt, outcome }`; archived → 409 `member_archived`; erasing → 409 `member_erasing`; row with removed contact approved → 422 `contact_removed`; RBAC pins: admin/super_admin 200, manager/marketing 403 + `permission_denied` audit, member 403; flag OFF → 404
- [ ] T046 [P] [US2] Contract test `tests/contract/members/admin-change-requests-review.test.ts` (`GET …/[id]`): `fields[].current` live, `changedSinceSubmitted` after a direct staff edit, `alreadyCurrent` when equal, `taxHint` ∈ `buyer_name|buyer_address|buyer_contact|billing_country|null`, `undecidable: 'contact_removed'`, `canDecide` false for manager / archived / erasing; other tenant's id → 404
- [ ] T047 [P] [US2] Unit test `tests/unit/members/change-requests/decide-change-request.test.ts` (100 % branches): outcome derivation; approval-time re-validation refusal; apply via `memberRepo.updateFieldsInTx` / `contactRepo.updateInTx` with the right patches (address group → all lines); `alreadyCurrent` no-op still recorded; audit `member_change_request_decided { related_member_id, request_id, outcome, fields: [{key, outcome}], reason_length }` with the reviewer as actor; one `member_change_request_decided_member` outbox row for the submitter in the contact's `preferred_language`; metrics `decided.total{outcome}` + `decide_ms`
- [ ] T048 [P] [US2] Integration test `tests/integration/members/change-requests-decide-rollback.test.ts`: fault-inject `contactRepo.updateInTx` to throw after the member write → member row unchanged, no decision, no audit, no outbox row, request still `pending`
- [ ] T049 [P] [US2] Integration test `tests/integration/members/change-requests-concurrency.test.ts`: two concurrent decides on one request → exactly one decision row + one audit + one email, the loser gets `already_decided`; 50 concurrent identical submits by one person → exactly one pending row (partial unique index)
- [ ] T050 [P] [US2] Unit test `tests/unit/members/infrastructure/change-request-decided-member-email.test.ts`: subjects per outcome ×3 locales; applied vs not-applied sections; reason verbatim + escaped (a `<script>` and a URL in the reason render as text); resubmit link `/portal/edit?resubmit=<id>`; reviewer name absent
- [ ] T115 [P] [US2] Integration test `tests/integration/members/change-requests-tax-document-immutability.test.ts` (FR-022, SC-012): issue an invoice for the member, approve a request changing company name + billing address + the primary's name, then assert the issued invoice's `MemberIdentitySnapshot` (`legal_name`, `address`, `primary_contact_name`) is byte-identical to before, and that a draft created before the approval and issued after it carries the approved values — RED before T051 is considered done

### Implementation for User Story 2

- [ ] T051 [US2] Implement `src/modules/members/application/use-cases/change-requests/decide-change-request.ts` (one `runInTenant`: `findByIdInTx` FOR UPDATE → state guard (`already_decided` with recorded decision; identical repeat → return recorded decision `repeated: true`; `not_pending`) → `memberRepo.findByIdInTx` FOR UPDATE archived/erasing guards → contact-removed guard per contact row → re-validate approved fields via `validateProposal` against then-current data → apply member patch with `updateFieldsInTx` and contact patch with `updateInTx` (no-op when already current) → `decideInTx` per-field outcomes + decision columns → `audit.recordInTx` → `email.enqueueInTx` for the submitter; `UseCaseAbort` everywhere after the first write) — T047/T048/T049 green
- [ ] T052 [US2] Implement `src/modules/members/application/use-cases/change-requests/get-change-request-review.ts` (request + fields + live current values + `changedSinceSubmitted` / `alreadyCurrent` / `undecidable` / `taxHint` + member flags + `canDecide` from `hasPermission(role, 'members.write')`) — T046 green
- [ ] T053 [US2] Implement `src/modules/members/infrastructure/email/change-request-decided-member-email.ts` and the dispatcher arm `case 'member_change_request_decided_member'` in `src/app/api/cron/outbox-dispatch/route.ts` (re-read the submitting contact's current email at dispatch; if removed/erased → skip + `email_dispatch_failed { reason: 'recipient_gone' }`) — T050 green
- [ ] T054 [US2] Route handlers `src/app/api/admin/change-requests/[id]/route.ts` (`GET`, `requireApiPermission('members.read')`) and `src/app/api/admin/change-requests/[id]/decide/route.ts` (`POST`, `requireApiPermission('members.write')`, body zod `{ decisions: [{key, outcome}], reason?, note? }`, `errorId` `M114.admin.decide.<arm>`) — T045 green
- [ ] T055 [US2] Review page `src/app/(staff)/admin/change-requests/[id]/page.tsx` (`requirePagePermission('members.read')`, `loading.tsx` shimmer, `not-found.tsx`) rendering `src/components/members/change-requests/change-request-decision-table.tsx`: every row a labelled checkbox pre-selected (Space toggles), address group one row, three-value display when `changedSinceSubmitted`, "already current" and "contact removed" (reject-only, checkbox disabled + `aria-disabled`) markers, tax flag by icon + text with `taxHint` copy; decision controls only when `canDecide`
- [ ] T056 [US2] Wire the confirming action to `src/components/shell/reason-confirmation-dialog.tsx`: dynamic title/description/confirm label from the selection (ICU plural keys "Approve all {n}" / "Approve {a}, reject {r}" / "Reject all {n}"), `reasonRequired = rejected > 0`, `destructive = rejected > 0`, focus starts on Cancel, spinner + stays open until the response, `finalFocus` → the confirm button; concurrency responses (`already_decided`, `member_archived`, `not_pending`) shown as user-facing copy and the page re-fetched
- [ ] T057 [US2] i18n keys for US2 in `src/i18n/messages/{en,th,sv}.json`: `admin.changeRequests.review.*`, `admin.changeRequests.decision.*` (incl. the three ICU plural labels), `admin.changeRequests.taxHint.*`, `email.changeRequest.decidedMember.*` ×3; `pnpm check:i18n` green
- [ ] T058 [US2] e2e (extend `tests/e2e/change-requests.spec.ts`): admin opens the email deep link (`?submitter=…` → redirect to `[id]`), de-selects one row, enters a reason, confirms → `/admin/members/[id]` and `/portal/profile` show the same values; manager sees the page read-only; axe zero violations on the review page at 320 px and desktop

**Checkpoint**: US2 green; decide is atomic and idempotent; commit `[Spec Kit] F114 US2 (green)`.

---

## Phase 5: User Story 3 — Staff reject some or all fields with a reason; nothing rejected applies; member is told why (Priority: P1)

**Goal**: The reject-all path, the decision shown on the portal until dismissed, and the resubmit form prefilled with exactly the rejected values.

**Independent Test**: Reject all with a reason → record unchanged, request `rejected`; member email carries the reason verbatim + link; `/portal/edit?resubmit=<id>` shows the reason and prefills only the rejected values; a new submission from there is a new request; the profile keeps the decision until dismissed.

### Tests for User Story 3 (RED first) ⚠️

- [ ] T059 [P] [US3] Extend `tests/contract/members/admin-change-requests-decide.test.ts`: all rows rejected + reason → `rejected`, member row untouched, email row present; rejected without reason → 422 (already pinned in T045 — assert the `rejected` outcome path specifically)
- [ ] T060 [P] [US3] Contract test `tests/contract/portal/change-requests-acknowledge.test.ts` (`POST …/[id]/acknowledge`): submitter → 200 with `outcomeAcknowledgedAt`; second call idempotent; another contact → 404; pending → 409 `not_decided`; no audit row
- [ ] T061 [P] [US3] Unit test `tests/unit/members/change-requests/acknowledge-change-request.test.ts` + a `portal-change-request-form` resubmit test `tests/unit/members/presentation/portal-change-request-form-resubmit.test.tsx` (prefill = rejected values only; approved fields start from live values; every Group B field editable)

### Implementation for User Story 3

- [ ] T062 [US3] Implement `src/modules/members/application/use-cases/change-requests/acknowledge-change-request.ts` (`acknowledgeInTx`; submitter-only; `not_decided` guard) and route `src/app/api/portal/change-requests/[id]/acknowledge/route.ts` — T060/T061 green
- [ ] T063 [US3] Edit page resubmit mode: `src/app/(member)/portal/edit/page.tsx` reads `?resubmit=<id>` (must be the caller's own decided request, else ignored), shows the reason + per-field outcomes above the form, and passes `initialValues` = live record with only the rejected proposed values substituted (T061 green)
- [ ] T064 [US3] Decision banner on `src/app/(member)/portal/profile/page.tsx` (`src/components/members/change-requests/decision-outcome-banner.tsx`): last decided request with `outcomeAcknowledgedAt IS NULL` — outcome badge (text + icon), applied/rejected lists, reason, "edit and resubmit" link, Dismiss button calling the acknowledge route; `role="status"`; hidden once acknowledged or once a newer request exists
- [ ] T065 [US3] i18n keys for US3 in `src/i18n/messages/{en,th,sv}.json`: `portal.changeRequests.outcome.*`, `portal.changeRequests.resubmit.*` ×3
- [ ] T066 [US3] e2e (extend `tests/e2e/change-requests.spec.ts`): reject-all → member follows the email link (captured from the outbox row in test) → form prefilled with rejected values → resubmit → new pending; dismiss the decision banner

**Checkpoint**: PR-1 complete — the submit → decide → resubmit loop works end-to-end behind the flag. Run `pnpm vitest run tests/contract/` (~4.3 min), the four US1–US3 integration files by path, `pnpm typecheck && pnpm lint`; open PR-1 with the reviewer set from T003.

---

## Phase 6: User Story 4 — A complete, visible history of requests and decisions (Priority: P2)

**Goal**: Staff see every request per member and tenant-wide (filterable, pending first, > 3 days flagged); the member sees their own + company-level requests; events appear on both timelines; erasure scrubs values, export includes history.

**Independent Test**: After one approved and one partially approved request, the member record section lists both with per-field outcomes; the queue filtered to `partially_approved` shows one; the secondary's portal history omits the primary's own-field request; `eraseMember` leaves no non-sentinel value in `member_change_request_fields`.

### Tests for User Story 4 (RED first) ⚠️

- [ ] T067 [P] [US4] Contract test `tests/contract/members/admin-change-requests-queue.test.ts` (`GET /api/admin/change-requests`): default `pending` oldest-first; filters `state`, `outcome`, `memberId`, `submitter`, `from`/`to`; `overdue` true past 3 days; `pendingCount` + `oldestPendingAgeSeconds`; keyset `cursor`/`limit ≤ 100`; manager 200, member 403, flag OFF 404
- [ ] T068 [P] [US4] Contract test `tests/contract/members/admin-member-change-requests.test.ts` (`GET /api/admin/members/[memberId]/change-requests`: all states newest-first; other tenant's member → 404)
- [ ] T069 [P] [US4] Contract test `tests/contract/portal/change-requests-history.test.ts` (`GET /api/portal/change-requests` + `GET …/[id]`): primary sees own + company-level; secondary sees own + company-level but **not** the primary's own-field request; `decidedBy` is `"organisation"`; out-of-scope id → 404
- [ ] T070 [P] [US4] Integration test `tests/integration/members/change-requests-erasure-scrub.test.ts`: after `eraseMember`, every `seen_value`/`proposed_value`/`decision_reason`/`decision_note` of the member's requests equals the erasure sentinel, pending rows are `withdrawn/erasure` with the system actor's audit row, row counts unchanged; extend the erasure guard suite (`tests/contract/members/admin-events-erase-by-email.test.ts` family) so the new table is asserted (table-scoped guard registration)
- [ ] T071 [P] [US4] Unit test `tests/unit/members/change-requests/list-change-requests.test.ts` (queue ordering, `waitingSeconds`/`overdue` derivation, FR-029 scope predicate `submitted_by_user_id = me OR scope IN ('company','mixed')`) and extend `tests/unit/members/presentation/timeline-event-item-i18n.test.tsx` with the three `timeline.audit.member_change_request_*` keys
- [ ] T119 [P] [US4] Integration test `tests/integration/members/change-requests-queue-pagination.test.ts` (plan § Technical Context queue budget): seed 5,000 requests across 200 members in one tenant, walk the queue with keyset `cursor`/`limit=100` and assert no duplicates / no gaps / stable order, `EXPLAIN` shows the `(tenant_id, state, submitted_at DESC)` index, and each page completes under `ciScaled(400)` ms — the 108 precedent for a stated budget is a seeded test, not a sentence

### Implementation for User Story 4

- [ ] T072 [US4] Implement `src/modules/members/application/use-cases/change-requests/list-change-requests.ts` (queue / per-member / portal-visible variants over `ChangeRequestRepo`; scope predicate in SQL; `pendingStats`) — T071 green
- [ ] T073 [US4] Route handlers `src/app/api/admin/change-requests/route.ts` (`GET` queue), `src/app/api/admin/members/[memberId]/change-requests/route.ts` (`GET`), `src/app/api/portal/change-requests/route.ts` (`GET` history — same file as T039's `POST`) and `src/app/api/portal/change-requests/[id]/route.ts` (`GET`) — T067/T068/T069 green
- [ ] T074 [US4] Queue page `src/app/(staff)/admin/change-requests/page.tsx` (+ `loading.tsx`, `error.tsx`; `requirePagePermission('members.read')`): filters (state/outcome/member/date), pending-first table with member, submitter role, field count, tax marker, waiting time + overdue badge (text + icon), `?submitter=…&state=pending` deep-link resolution (redirect to `[id]` when exactly one, else the "no pending request — decided by X at T" notice), empty state "No requests waiting"
- [ ] T075 [US4] Member record section `src/app/(staff)/admin/members/[memberId]/_components/member-change-requests-section.tsx` (newest first, per-field outcomes via the shared diff table, reviewer name + `deactivated` marker, link to the review page) mounted on `src/app/(staff)/admin/members/[memberId]/page.tsx` under a real `<h2>`
- [ ] T076 [US4] Portal history page `src/app/(member)/portal/change-requests/page.tsx` (+ `loading.tsx`, `error.tsx`): the FR-029-scoped list with `decidedBy` shown as the organisation, empty state, link from the profile page
- [ ] T077 [US4] Timeline copy: `timeline.audit.member_change_request_{submitted,decided,withdrawn}` in `src/i18n/messages/{en,th,sv}.json`; confirm the three events surface on `/admin/members/[id]/timeline` and `/portal/timeline` via the existing `member_timeline_v` audit arm (no view change) — T071 green
- [ ] T078 [US4] Erasure: implement `src/modules/members/infrastructure/adapters/change-request-scrub-adapter.ts` (`ChangeRequestScrubPort`: values, reason, note → sentinel from `domain/erasure-sentinels.ts`; pending → `withdrawn/erasure`; emit `member_change_request_withdrawn { related_member_id, request_id, reason: 'erasure' }` with the system actor) and call it inside step 2 (the atomic scrub tx) of `src/modules/members/application/use-cases/erase-member.ts`; wire in `buildEraseMemberDeps` — T070 green
- [ ] T079 [US4] DSAR export: add a `change_requests` section (scoped as FR-029 for the requesting person; each request with its per-field seen/proposed values and outcomes, the decision reason and note — FR-014 — submission/decision times and the organisation as decider) to the member data export use case in `src/modules/insights/application/use-cases/` reached from `src/app/api/portal/account/data-export/route.ts`, with a contract assertion in `tests/contract/portal/data-export-route.contract.test.ts`
- [ ] T080 [US4] i18n keys for US4 in `src/i18n/messages/{en,th,sv}.json`: `admin.changeRequests.queue.*`, `admin.changeRequests.filters.*`, `admin.members.changeRequests.*`, `portal.changeRequests.history.*`, `nav.staff.changeRequests` (+ breadcrumb) ×3
- [ ] T081 [US4] e2e (extend `tests/e2e/change-requests.spec.ts`): queue filter → review; member record section; secondary's history scope; axe on queue, member section and portal history at 320 px

**Checkpoint**: US4 green incl. the erasure scrub integration test; commit `[Spec Kit] F114 US4 (green)`.

---

## Phase 7: User Story 5 — Member withdraws or replaces a pending request (Priority: P2)

**Goal**: Withdraw with confirmation; resubmit replaces only the submitter's own pending request; staff email coalesced within 1 h of the last notification; the durable 10-per-24 h cap.

**Independent Test**: Submit then `DELETE …/current` → `withdrawn/member`, queue no longer lists it, second DELETE → 404; two submits within a minute → one pending, first `withdrawn/replaced`, one staff email; 11th submission in 24 h → 429 + `Retry-After` + audit, with `UPSTASH_*` unset.

### Tests for User Story 5 (RED first) ⚠️

- [ ] T082 [P] [US5] Contract test `tests/contract/portal/change-requests-withdraw.test.ts` (`DELETE …/current`): 200 → `withdrawn/member` + audit `member_change_request_withdrawn { member_id, request_id, reason: 'member' }`; second call → 404 `no_pending_request`; a different contact's pending request is untouched; staff → 403
- [ ] T083 [P] [US5] Contract test `tests/contract/portal/change-requests-replace.test.ts`: second submit by the same person → previous `withdrawn/replaced` with `replaced_by_request_id`, response `replaced: <id>`, `staffNotified: false` when the previous `staff_notified_at` is < 1 h old and the new row inherits it; > 1 h → new email; a decision that landed meanwhile is **not** withdrawn (new request created, previous stays `decided`); 11 submits in 24 h → 429 `rate_limited` with `Retry-After` + audit `member_change_request_rate_limited { member_id, window_count, retry_after_seconds }`; replaced requests count toward the cap
- [ ] T084 [P] [US5] Integration test `tests/integration/members/change-requests-rate-cap.test.ts` (live Neon, `UPSTASH_REDIS_REST_URL` unset): the cap holds from the table count alone; the 24 h window rolls (clock-injected)
- [ ] T085 [P] [US5] Unit tests: `tests/unit/members/change-requests/withdraw-change-request.test.ts` (100 % branches) and extend `submit-change-request.test.ts` with the replace / coalescing / cap branches (`coalesced: true` in the audit payload; metric `submitted.total{coalesced=true}`; `refused.total{reason=rate_limited}`)

### Implementation for User Story 5

- [ ] T086 [US5] Implement `src/modules/members/application/use-cases/change-requests/withdraw-change-request.ts` (one `runInTenant`: `findPendingBySubmitterInTx` FOR UPDATE → `withdrawInTx(id, 'member')` → audit; `no_pending_request` when none) — T085 green
- [ ] T087 [US5] Extend `submit-change-request.ts`: inside the tx, `countSubmittedSince(userId, now − 24 h)` ≥ 10 → `rate_limited` (retry-after from the oldest row in the window) + audit + metric, **before** any write; if a pending row exists and differs → `withdrawInTx(prev, 'replaced', newId)` then insert; coalescing: inherit `staff_notified_at` and skip the outbox rows when `now − prev.staff_notified_at < 1 h`, audit `coalesced: true`; a previous row that is no longer `pending` at the FOR UPDATE read is left alone (new request) — T083/T084/T085 green
- [ ] T088 [US5] Route handler `src/app/api/portal/change-requests/current/route.ts` (`DELETE`; `requireMemberContext`; 404 `no_pending_request`; `errorId` `M114.portal.withdraw.<arm>`); 429 responses via `rateLimitedJson` from `src/lib/rate-limit-helpers.ts` in the `POST` handler — T082/T083 green
- [ ] T089 [US5] Withdraw control in `src/components/members/change-requests/pending-request-banner.tsx`: "Withdraw request" opens the shared `ConfirmationDialog` (`src/components/shell/confirmation-dialog.tsx`, non-destructive tier, focus on Cancel, `finalFocus` back to the trigger), calls `DELETE …/current`, announces the result via the banner's live region
- [ ] T090 [US5] i18n keys for US5 in `src/i18n/messages/{en,th,sv}.json`: `portal.changeRequests.withdraw.*`, `portal.changeRequests.replaced.*`, `portal.changeRequests.rateLimited.*` ×3
- [ ] T091 [US5] e2e (extend `tests/e2e/change-requests.spec.ts`): withdraw with confirmation; resubmit twice → one pending; the 11th submission shows the rate-limit message with the retry time

**Checkpoint**: PR-2 complete (US4 + US5). Run the contract folder, the five integration files by path, `pnpm typecheck && pnpm lint`; open PR-2.

---

## Phase 8: User Story 6 — Approval requirement is a tenant choice; pending work is visible at a glance (Priority: P3)

**Goal**: The per-tenant switch with audit, the dashboard "Needs attention" item, the nav badge, and the gauges + alerts.

**Independent Test**: Setting OFF → a Group B edit saves immediately and emits `member_self_updated`; pending rows stay decidable; ON → dashboard shows "N change requests waiting · oldest X days" linking to the queue and the Membership nav item carries the count; each flip is audited with `{ previous, next }`.

### Tests for User Story 6 (RED first) ⚠️

- [ ] T092 **V2** [US6] Read `src/app/api/internal/metrics/broadcasts-gauges/route.ts` and record in `research.md § V2` whether it can host a second module's per-tenant gauges without renaming any `broadcasts_*` metric (if not, the fallback is a `members` block in the same tick with its own try/catch — never a new cron: `vercel.json` has 37 of 40)
- [ ] T093 [P] [US6] Contract test `tests/contract/members/admin-member-changes-setting.test.ts` (`GET`/`PATCH /api/admin/settings/member-changes`): admin/super_admin 200; manager/marketing 403 + `permission_denied` audit; a change emits `member_change_approval_setting_changed { previous, next }`; an unchanged value emits nothing; `GET` returns `pendingCount`; flag OFF → 404
- [ ] T094 [P] [US6] Contract test `tests/contract/portal/change-requests-setting-off.test.ts`: setting OFF → `gate.mode = immediate`, `PATCH /api/portal/profile` accepts Group B again and emits `member_self_updated` (SC-011 regression via the existing `profile.test.ts` assertions), `POST …/change-requests` → 409; pending rows from before the flip remain decidable (`POST …/decide` 200)
- [ ] T095 [P] [US6] Unit tests `tests/unit/members/change-requests/set-member-change-approval-enabled.test.ts` (100 % branches) and `tests/unit/members/change-requests/count-pending-change-requests.test.ts`
- [ ] T096 [P] [US6] Unit/RSC tests: the dashboard `NeedsAttentionItem` appears only when the flag is on and `pendingCount > 0`, labelled with count + oldest age, `href: '/admin/change-requests'` (`tests/unit/insights/**` alongside the existing dashboard tests); the nav item `nav.staff.changeRequests` is guarded by `members.read` and carries `badgeCount` (`tests/unit/**/nav*.test.ts` parity suites — `SurfaceGuard` / `staffNavAllowedHrefs` unchanged)
- [ ] T118 [P] [US6] Contract/RSC test `tests/contract/portal/change-requests-flag-off.test.ts` (FR-039): with `FEATURE_MEMBER_CHANGE_APPROVAL=false` and rows present from a previous flag-on run — every new route → 404, the profile page renders no pending/decision banner, the staff nav carries no badge and the dashboard no item, `PATCH /api/portal/profile` accepts the full flag-OFF field set, and the rows are untouched and decidable again once the flag returns

### Implementation for User Story 6

- [ ] T097 [US6] Implement `src/modules/members/application/use-cases/change-requests/set-member-change-approval-enabled.ts` (upsert `tenant_member_settings.member_change_approval_enabled`; no-op when unchanged; audit `member_change_approval_setting_changed { previous, next }` with the staff actor) and `count-pending-change-requests.ts` (`pendingStats` → `{ count, oldestAgeSeconds }`) — T095 green
- [ ] T098 [US6] Route handler `src/app/api/admin/settings/member-changes/route.ts` (`GET` + `PATCH`, `requireApiPermission('members.write')`, `errorId` `M114.admin.setting.<arm>`) — T093/T094 green
- [ ] T099 [US6] Settings card `src/app/(staff)/admin/settings/member-changes/page.tsx` (`requirePagePermission('members.write')`; Switch with the pending-count warning when switching off; audited) and the category card in `src/app/(staff)/admin/settings/page.tsx`
- [ ] T100 [US6] Dashboard: add the live `NeedsAttentionItem` (count + oldest age via `count-pending-change-requests`, one indexed query at render) to the `needsAttentionItems` list in `src/app/(staff)/admin/(home)/page.tsx` — T096 green
- [ ] T101 [US6] Nav: add `nav.staff.changeRequests` under the Membership section in `src/config/nav.ts` (`href: '/admin/change-requests'`, `defineGuard('members.read')`, `activePattern`), add the optional `badgeCount?: number` slot to the staff nav item type, and resolve it server-side in `src/components/layout/staff-shell.tsx` from `count-pending-change-requests` (rendered as text with an `aria-label`, hidden when 0 or flag off) — T096 green
- [ ] T102 [US6] Gauges: emit `members.change_requests_pending_count{tenant}` and `members.change_request_oldest_age_seconds{tenant}` from the per-tenant gauges tick per V2 (`src/app/api/internal/metrics/broadcasts-gauges/route.ts` or its generalised successor), and document `docs/observability.md` § 14 (metrics table, alerts: `oldest_age_seconds > 7 d` warning, `> 14 d` page, owner, runbook link)
- [ ] T103 [US6] i18n keys for US6 in `src/i18n/messages/{en,th,sv}.json`: `admin.settings.memberChanges.*`, `admin.dashboard.needsAttention.changeRequests`, `nav.staff.changeRequests` badge label ×3
- [ ] T104 [US6] e2e (extend `tests/e2e/change-requests.spec.ts`): flip the setting off → immediate save; on → dashboard item + nav badge; `/admin/audit` shows the setting event

**Checkpoint**: US6 green; commit `[Spec Kit] F114 US6 (green)`.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Coverage pins, observability, runbook, docs, the review round and the cutover record.

- [ ] T105 [P] Pin 100 % branches in `vitest.config.ts` for `submit-change-request.ts`, `withdraw-change-request.ts`, `decide-change-request.ts`, `acknowledge-change-request.ts`, `set-member-change-approval-enabled.ts`, `resolve-member-change-gate.ts`; Domain `domain/change-request/**` at 100 % lines; run `pnpm test:coverage`
- [ ] T106 [P] OTel spans `members.change_request.submit` / `members.change_request.decide` (attributes `tenant.slug`, `change_request.id`, `change_request.scope`, `change_request.outcome`, `change_request.field_count` — never values) in the two use cases via the existing `src/lib/otel.ts` helpers; pino log fields limited to ids per `docs/observability.md` § 3
- [ ] T107 [P] `errorId` taxonomy: every failing arm in the nine route handlers names itself (`M114.<route>.<arm>`); add a positive-control assertion in `tests/unit/architecture/` (or extend `check:f8-error-id`'s pattern for `M114.*`) so a shared-literal regression fails loudly
- [ ] T108 [P] Runbook `docs/runbooks/member-change-requests.md`: stuck pending queue, "why no email?" (coalescing), "why 429?" (durable cap), dispatcher failures for the two new types, the no-reviewer warning, the rollback matrix (quickstart § 3)
- [ ] T109 [P] Docs: `docs/changelog.md` entry; CLAUDE.md § Recent Changes + Active Technologies lines (migration `0300`, 5 audit events → F3 count, 2 notification types, flag name); `docs/code-conventions.md` unchanged
- [ ] T110 Static gates (`package.json` scripts, run from the repo root): `pnpm check:staff-page-guard`, `check:api-route-guard`, `check:authorization-role-reads`, `check:actor-role-truth` (no role literal in any `actorRole:` position — the system actor on erasure closure uses the erasure use case's existing system identity), `check:layout` (every new page inside the container pattern), `check:fixme`, `check:dates`, `check:i18n`, `check:multi-tenant`, `check:audit-events` — all green
- [ ] T111 Full local gate before PR-3: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm vitest run tests/contract/ && pnpm test:integration <each of the six F114 integration files by path> && pnpm test:e2e --grep "@change-requests" --workers=1 && pnpm test:e2e --grep "@a11y" --workers=1`
- [ ] T112 Review round (read-only agents concurrently, then the seam pass): `security-engineer`, `pdpa-gdpr-compliance-officer`, `reliability-guardian`, `drizzle-migration-reviewer`, `enterprise-ux-designer`, `thai-tax-compliance-auditor`, `i18n-translation-reviewer`, then `whole-branch-reviewer` (or `review-branch` on opt-in); tick the six checklists at `/speckit.review`; record in `specs/114-member-change-approval/reviews/`
- [ ] T113 Quickstart validation: walk `quickstart.md` § 1 for all six stories on the dev branch with the flag on and the setting on; record deviations in `reviews/quickstart-run-<date>.md`
- [ ] T114 Ship-day (after PR-3 merges): `pnpm db:verify:prod`; update the RoPA entry (FR-040); set `FEATURE_MEMBER_CHANGE_APPROVAL=true` in Vercel only when ready to redeploy immediately; switch SweCham's setting on; observe the first submission (staff email, queue, dashboard count 1, gauge 1) and record it in `reviews/cutover.md` with the rollback matrix

### Added by `/speckit.superb.review` (2026-09-11) — cross-cutting coverage gaps (T115 sits in Phase 4, T118 in Phase 8)

- [ ] T116 Contract assertions for read-only mode (FR-036): with `READ_ONLY_MODE=true`, `POST /api/portal/change-requests`, `DELETE …/current`, `POST …/[id]/acknowledge`, `POST /api/admin/change-requests/[id]/decide` and `PATCH /api/admin/settings/member-changes` return 503 `read-only-mode` while every `GET` still answers — added to `tests/contract/portal/change-requests-submit.test.ts` and `tests/contract/members/admin-change-requests-decide.test.ts` using the F1 read-only harness
- [ ] T117 [P] Architecture guard `tests/unit/architecture/change-requests-no-server-actions.test.ts` (FR-038): scans `src/app/api/portal/change-requests/**`, `src/app/api/admin/change-requests/**`, `src/app/api/admin/settings/member-changes/**`, `src/app/(member)/portal/change-requests/**`, `src/app/(staff)/admin/change-requests/**` and `src/components/members/change-requests/**` for a `'use server'` directive and fails on any hit; carries a positive control (a fixture string containing the directive must be detected) so the guard cannot pass vacuously

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T003/T004 parallel.
- **Foundational (Phase 2)**: depends on Phase 1; **blocks every story**. Order inside: T005–T007 (verify facts) → T008–T010 (migration, applied + verified before any code that references the enums/columns is committed) → T011–T015 [P] (schema/enum/i18n) → T016–T020 (Domain, TDD) → T021 → T022/T023 (repo, TDD) → T024/T025 (gate) → T026–T028 [P].
- **US1 (Phase 3)** → **US2 (Phase 4)** → **US3 (Phase 5)**: US2 needs US1's request rows; US3 needs US2's decisions. Together they are PR-1. T115 (tax-document immutability) is RED before T051 closes; T119 (5,000-row pagination) is RED before T072 closes; T118 (flag OFF surfaces) is RED before T101 closes.
- **US4 (Phase 6)** and **US5 (Phase 7)**: both depend on Phase 2 + US1 (rows to list / withdraw); independent of each other; PR-2.
- **US6 (Phase 8)**: depends on Phase 2 (gate resolver + setting column); the dashboard/nav tasks read rows from US1; PR-3.
- **Polish (Phase 9)**: after all stories; T114 after PR-3 merges.

### Within Each User Story

- RED tests first (commit red) → use cases → routes → pages/components → i18n → e2e; commit green per task or group.
- Same-file sequencing: `submit-change-request.ts` is written in US1 (T036) and extended in US5 (T087); `src/app/api/portal/change-requests/route.ts` gets `POST` in US1 (T039) and `GET` in US4 (T073); `outbox-dispatch/route.ts` gets one arm in US1 (T037) and one in US2 (T053); `tests/e2e/change-requests.spec.ts` grows per story — none of these pairs are [P].

### Parallel Opportunities

- Phase 2: T011–T015 (five different files), T026–T027.
- Every story's RED tests block (different files) — T029–T035, T045–T050, T059–T061, T067–T071, T082–T085, T093–T096.
- Phase 9: T105–T109.

---

## Parallel Example: User Story 1

```bash
# RED — six test files at once (different files, no dependencies):
Task: "Contract test tests/contract/portal/change-requests-submit.test.ts"
Task: "Contract test tests/contract/portal/change-requests-gate.test.ts"
Task: "Extend tests/contract/portal/profile.test.ts with gate=approval refusals"
Task: "Unit test tests/unit/members/change-requests/submit-change-request.test.ts"
Task: "Integration test tests/integration/members/change-requests-tenant-isolation.test.ts"
Task: "Integration test tests/integration/members/change-requests-submit-atomicity.test.ts"
# GREEN — sequential (T036 → T037 → T038 → T039 → T040/T041/T042 → T043 → T044)
```

---

## Implementation Strategy

### MVP = PR-1 (Phases 1–5)

1. Phase 1 + Phase 2 → foundation (migration on dev, Domain 100 %, repo + gate green).
2. US1 → US2 → US3, each RED → GREEN → commit.
3. **STOP and VALIDATE**: quickstart § 1 US1–US3 on dev with the flag on; contract folder + four integration files; e2e `@change-requests`.
4. Open PR-1 (dark: flag default OFF, tenant setting default false). Prod gets the migration + enum values on merge and nothing else changes.

### Incremental Delivery

- PR-2 adds history + withdraw/replace/cap (US4 + US5); PR-3 adds the tenant switch, dashboard, gauges, runbook (US6 + polish). Each PR is reviewable and rollback-able per the quickstart matrix; the first real behaviour change for SweCham happens only at T114.

### Verify-before-task ledger

| Item | Task | Blocks |
|---|---|---|
| V1 canonical website rule | T005 | T018/T019 (parity test) |
| V2 gauges cron host | T092 | T102 |
| V3 dispatcher tenant tx at send | T006 | T037/T053 |
| V4 prod secondary-with-login count | T007 | test seeding in T033/T069/T081 |

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- Every data-model constraint is quoted in T008; the use-case tasks name the guards they must enforce so none is left to discretion.
- Never `return err()` inside a `runInTenant` callback — throw `UseCaseAbort` (T036, T051, T086, T087).
- `actorRole` is always the session role; the erasure closure uses the erasure use case's system actor (T078).
- Verify tests fail before implementing; commit after each task or logical group; stop at any checkpoint to validate the story independently.
