# Tasks: F3 — Member & Contact Management + Smart Features

**Input**: Design documents from `/specs/005-members-contacts/`
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓, security.md ✓
**Tests**: TDD is NON-NEGOTIABLE per Constitution Principle II — test tasks precede implementation tasks and MUST be authored red + committed before matching implementation lands.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: US1–US7 for user-story-scoped tasks; omitted for Setup / Foundational / Polish
- Every task includes an exact file path
- Tests tagged `@f3` for E2E filtering; `@a11y` for axe-core; `@i18n` for locale coverage

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install new dependencies, configure ESLint boundaries, extend i18n scaffolding.

- [X] T001 Install `@tanstack/react-table@^8` + `i18n-iso-countries@^7` via `pnpm add` and verify React 19 compat per research § 7 and § 10
- [X] T002 [P] Install shadcn primitives `checkbox`, `combobox`, `calendar` via `pnpm dlx shadcn@latest add checkbox combobox calendar` (combobox = Popover + Command composition, no separate primitive)
- [X] T003 [P] Extend `eslint.config.mjs` with `no-restricted-imports` rules forbidding (a) deep imports into `src/modules/members/{domain,application,infrastructure}` from outside the module, (b) `@/modules/auth/domain/**` imports from `src/modules/members/**` (per Plan E2 branded-UserId rule)
- [X] T004 [P] Extend `vitest.config.ts` coverage config to include `src/modules/members/**` with Domain=100% line, Application=80% line+branch, 100% branch on security-critical use cases listed in plan § Constitution Check II
- [X] T005 [P] Scaffold i18n keys: add `admin.members.*`, `admin.members.overrideReason.*`, `admin.members.bundleChangeWarning.*`, `portal.profile.*`, `audit.eventType.{23 F3 events}` across `src/i18n/messages/{en,th,sv}.json` (367 keys × 3 locales, `pnpm check:i18n` OK)
- [X] T006 [P] Add environment variable `FEATURE_F3_MEMBERS` (default `true`) to `src/lib/env.ts` zod schema and document in `.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database schema, RLS, audit-log extension, Domain types, RBAC — all user stories depend on these.

### Database schema + RLS

- [X] T007 Author integration test `tests/integration/members/migration-schema.test.ts` — 9/9 green; asserts members + contacts tables, pg_trgm, 9 key indexes, RLS + FORCE, 23 audit enum values, `member_status` enum, trigger installation
- [X] T008 Create Drizzle schema `src/modules/members/infrastructure/db/schema-members.ts` matching data-model § 1.1 (including `last_activity_at` denorm column)
- [X] T009 Create Drizzle schema `src/modules/members/infrastructure/db/schema-contacts.ts` matching data-model § 1.2
- [X] T010 Migration `drizzle/migrations/0009_members_contacts.sql` — base generated via drizzle-kit, hand-extended with pg_trgm, GIN trgm indexes, composite FKs, 19 CHECK constraints, chamber_app DML + enum USAGE grants, RLS + FORCE + policies (ENABLE/ALL/USING+WITH CHECK on both tables), SECURITY DEFINER last_activity_at trigger function (numbered 0009 because 0008 was already consumed by F2 polish migration `0008_money_columns_to_bigint.sql`)
- [X] T011 Trigger `audit_log_bump_member_last_activity` in migration 0009 — SECURITY DEFINER function with scoped `UPDATE members SET last_activity_at = NEW.timestamp WHERE member_id = (NEW.payload->>'member_id')::uuid AND tenant_id = NEW.tenant_id`; gracefully skips malformed payloads via exception handler (R2-E3 requirement)
- [X] T012 Integration test `tests/integration/members/tenant-isolation.test.ts` — **14/14 green on live Neon Singapore** (Review-Gate blocker — Constitution v1.4.0 Principle I clause 3). Covers: members + contacts SELECT/UPDATE/DELETE/INSERT isolation both directions, RLS WITH CHECK rejection on forged tenant_id, secure-default zero rows when `app.current_tenant` unset, per-tenant email uniqueness (consultant across tenants), primary-contact partial unique index enforcement, cross-tenant composite FK violation
- [X] T013 New test `tests/integration/rls-coverage.test.ts` — 8/8 green; parametrized `it.each` loop over `[membership_plans, tenant_fee_config, members, contacts]` asserting (a) `rowsecurity=true, forcerowsecurity=true` via `pg_class`, (b) every policy's `qual` references `current_setting('app.current_tenant', ...)`. Net future-proofing: any new tenant-scoped table added without RLS red-fails CI here (critique E12)

### Audit log extension

- [X] T014 Migration `drizzle/migrations/0010_audit_log_f3_extension.sql` — 23 `ALTER TYPE audit_event_type ADD VALUE` statements wrapped in idempotent `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'audit_event_type' AND e.enumlabel = '...') THEN ... END IF; END$$` blocks (same pattern as F2 migration 0007). Numbered 0010 because the members_contacts migration took slot 0009. Journal `_journal.json` updated to register it.
- [X] T015 Applied both migrations via `pnpm db:migrate` to live Neon Singapore; verified via direct pg_enum + pg_class + pg_extension + information_schema queries — all 23 new audit event types present, pg_trgm enabled, RLS enabled+forced on both tables, trigger installed, 4/4 key indexes present

### Domain layer — tenants module reuse + members module skeleton

- [X] T016 [P] Public barrel `src/modules/members/index.ts` — exports Domain types + value-object constructors (exports expanded story-by-story; use-case exports added when Application layer lands)
- [X] T017 [P] `domain/value-objects/email.ts` — RFC 5322-simplified regex + lowercase normalization + 254-char RFC 5321 cap + 4 error codes (empty / too_long / invalid_format)
- [X] T018 [P] `domain/value-objects/phone.ts` — E.164 (+[1-9]{7,14}$) + strips ASCII formatting chars before validation
- [X] T019 [P] `domain/value-objects/iso-country-code.ts` — `i18n-iso-countries.isValid()` (pure-data lookup, no framework) + uppercase + trim
- [X] T020 [P] `domain/value-objects/tax-id.ts` — country-aware: Thai (`country='TH'`) enforces 13-digit format + checksum; others are length 1..50 with no checksum
- [X] T021 [P] `domain/value-objects/override-reason.ts` — 4-enum + 500-char note + "other requires note" invariant
- [X] T022 [P] `domain/value-objects/user-id.ts` — branded opaque UUID-validated UserId (lowercase-normalized). ESLint rule (added in T003) forbids `@/modules/auth/domain/**` imports from members/** so the opacity is enforced at build time
- [X] T023 [P] `domain/member.ts` — Member aggregate type + `MEMBER_STATUSES` + `setStatus`, `archive`, `undelete` (90-day window) state transitions returning `Result<Member, MemberStateError>`
- [X] T024 [P] `domain/contact.ts` — Contact entity type + `PREFERRED_LANGUAGES` + `isPreferredLanguage` guard
- [X] T025 [P] `domain/policies/primary-contact-invariant.ts` — `assertPrimaryContactInvariant(contacts, memberStatus)`; rule suspended when status='archived'; reports zero / multiple / removed-and-primary violations
- [X] T026 [P] `domain/policies/turnover-policy.ts` — `checkTurnoverBand(turnoverThb, {minThb, maxThb})`; null turnover skips, null-bound sides are open
- [X] T027 [P] `domain/policies/age-eligibility-policy.ts` — `checkAgeEligibility(dob, planStart, maxAge=35)`; handles month/day delta; inclusive `<=`
- [X] T028 [P] `domain/policies/startup-duration-policy.ts` — `checkStartupDuration(foundedYear, regDate, maxYears=2)`
- [X] T029 [P] `domain/policies/archive-window-policy.ts` — `archiveWindowStatus(archivedAt, now)` reports not_archived / within_window (daysRemaining) / window_expired
- [X] T030 [P] `domain/policies/thai-tax-id-checksum.ts` — official Revenue Department 13-digit weighted-sum algorithm
- [X] T031 [P] `domain/portal-self-update-fields.ts` — split tuples: `PORTAL_SELF_UPDATE_CONTACT_FIELDS = ['firstName','lastName','phone','preferredLanguage']` + `PORTAL_SELF_UPDATE_MEMBER_FIELDS = ['website','description']` (FR-014a)
- [X] T032 Unit tests for every value object + policy — **89/89 green** across 10 test files in `tests/unit/members/domain/**` (email, phone, iso-country-code, tax-id, override-reason, user-id, thai-tax-id-checksum, member-state, contact, policies.test.ts)

### Application layer ports

- [X] T033 Ports `application/ports/{member-repo,contact-repo,audit-port,clock-port,email-port,session-revocation-port,plan-lookup-port}.ts` — 7 interface files, zero implementation, returning `Result<T, RepoError>` throughout. `F3AuditEventType` union literal covers all 23 event types from data-model § 4

### RBAC extension

- [X] T034 Extended `src/modules/auth/domain/policies.ts` (the authoritative RBAC policy — `rbac-guard.ts` lives in `src/lib/` and reads from this) with F3 resource literals: `members`, `members:bulk`, `members:own`, `contacts`, `contacts:own`. Admin full CRUD, manager read-only, member RW on `*:own` only, bulk admin-only
- [X] T035 `tests/unit/auth/rbac-guard-f3.test.ts` — **21/21 green** covering the admin/manager/member × CRUD × 5 resources matrix including explicit denials (member cannot read directory, manager cannot bulk, member cannot delete own profile)

### Feature flag infra

- [X] T036 `src/lib/feature-flags.ts` + extended `src/proxy.ts` with the FEATURE_F3_MEMBERS kill-switch branch — when `env.features.f3Members` is false, every `/api/members/**` and `/api/portal/**` request (read OR write) returns 503 `read_only_mode` with Retry-After: 300, applied BEFORE the CSRF check so disabling is unconditional
- [X] T037 `tests/integration/middleware/feature-flag-f3-kill-switch.test.ts` — **7/7 green**; covers GET/POST/PATCH on `/api/members`, `/api/members/:id`, `/api/portal/profile` + non-F3 paths (`/api/auth/me`, `/api/plans`) pass through unaffected. Same `vi.mock('@/lib/env', …)` pattern as F2's READ_ONLY_MODE test

### Observability

- [X] T038 [P] Pino REDACT_PATHS extended with: `email`, `toEmail`, `phone`, `date_of_birth`, `dateOfBirth`, `tax_id`, `taxId` (top-level + one-level-deep `*.` variants). Uses `[REDACTED]` censor, matches existing F1 pattern
- [X] T039 [P] `docs/observability.md § 14 F3 Members & Contacts` — 10 metrics (members.api.latency/requests, search.latency, bulk.rows_per_action, cross_tenant_probe.count, self_update_forbidden.count, email_change.count, bundle_warning_count.latency, outbox.dispatch.latency/failures) + SLO targets from plan (p95 < 400ms, search p95 < 500ms, bulk 100 rows p95 < 5s, bundle warning p95 < 200ms) + high-severity audit event thresholds + PII redaction (T038) reference

---

## Phase 3: User Story 1 — Admin creates member with primary contact (P1) 🎯 MVP

**Story goal**: Admin can create a new member + primary contact + audit event in one transaction.
**Independent test**: Open Create Member, fill one member + one primary contact, save, verify row in directory + audit event.
**US1 requirements covered**: FR-002, FR-003, FR-006, FR-006a, FR-007, FR-008, FR-009a, FR-011, FR-012 (invite), FR-031 (soft-dedupe), FR-033 (ux-standards inherit), FR-035 (required-field indicator), FR-036 (autocomplete), FR-037 (page title).

### Tests-first (red)

- [ ] T040 [P] [US1] Author failing contract test `tests/contract/members/create-member.test.ts` for `POST /api/members` matching `contracts/members-api.md § Endpoint 2`
- [ ] T041 [P] [US1] Author failing integration test `tests/integration/members/create-member.test.ts` covering happy path + override-reason flow + soft-dedupe + plan/turnover/age validations + **FR-032 sub-scenario**: create two members in different tenants with the same contact email → both succeed silently, no warning surfaced, per-tenant unique index holds independently (Principle I privacy guarantee)
- [ ] T042 [P] [US1] Author failing integration test `tests/integration/members/invitation-bounce.test.ts` (spec edge case) — simulates Resend `email.bounced` webhook; asserts `invitation_bounced` audit + re-send action availability
- [ ] T043 [P] [US1] Author failing E2E spec `tests/e2e/members-create.spec.ts @f3 @a11y @i18n` covering create happy path across EN/TH/SV + keyboard-only run + axe-core

### Application + Infrastructure

- [ ] T044 [P] [US1] Implement `src/modules/members/application/use-cases/create-member.ts` — takes `TenantContext` + Member draft + primary contact + optional override; enforces invariants via domain policies; returns `Result<{member_id, contact_id}, E>`
- [ ] T045 [P] [US1] Implement `src/modules/members/application/use-cases/check-soft-duplicate.ts` for FR-031 (exact company_name + country match within tenant)
- [ ] T046 [P] [US1] Implement `src/modules/members/application/use-cases/invite-portal.ts` wrapping F1 invitation port with member-scoped binding
- [ ] T047 [US1] Implement `src/modules/members/infrastructure/repos/drizzle-member-repo.ts` (create + findSoftDuplicate + audit-aware insert)
- [ ] T048 [US1] Implement `src/modules/members/infrastructure/repos/drizzle-contact-repo.ts` (create + primary partial-index handling)
- [ ] T049 [US1] Implement `src/modules/members/infrastructure/adapters/resend-email-port.ts` — outbox-backed dispatch for invitation
- [ ] T050 [US1] Wire composition root `src/modules/members/members-deps.ts` + export from barrel

### Presentation

- [ ] T051 [P] [US1] Implement API route `src/app/api/members/route.ts` (POST create) — zod validation, idempotency key, RBAC admin-only
- [ ] T052 [US1] Implement create page `src/app/(staff)/admin/members/new/page.tsx` with breadcrumb + FR-037 page title
- [ ] T053 [US1] Implement `src/app/(staff)/admin/members/_components/member-form.tsx` — RHF + zod schema generated from domain types; required fields marked per **FR-035 tri-part indicator** (`aria-required="true"` programmatic + visual asterisk + form-top "* fields are required" note — all three present); **FR-036 autocomplete attrs** explicitly: `given-name` / `family-name` on contact name, `email`, `tel` on phone, `organization` on company name; country Combobox; DOB Calendar visible only when plan = Thai Alumni
- [ ] T053a [P] [US1] Author unit test `tests/unit/members/presentation/member-form-a11y.test.tsx` asserting FR-035 tri-part indicator rendered for every required field + FR-036 autocomplete attrs present on expected inputs
- [ ] T054 [US1] Implement `src/app/(staff)/admin/members/_components/override-reason-dialog.tsx` — enum select + conditional note textarea (FR-006a)
- [ ] T055 [US1] Implement `src/app/(staff)/admin/members/_components/soft-duplicate-dialog.tsx` (FR-031) with Proceed / Cancel + "open existing" link
- [ ] T056 [US1] Add "Invite to portal" action to member detail page (route target US2 T067) — visible only when primary contact has email

### i18n

- [ ] T057 [US1] Fill i18n keys `admin.members.create.*` + `admin.members.overrideReason.*` + `admin.members.softDuplicate.*` across EN/TH/SV

---

## Phase 4: User Story 2 — Directory search, filter, open detail (P1) 🎯 MVP

**Story goal**: Admin can find any member in ≤ 500ms substring search + open detail page.
**Independent test**: Type "Fog" in directory, see filtered rows, apply plan-tier filter, click row → detail.
**US2 requirements covered**: FR-001, FR-004, FR-016, FR-017, FR-021, FR-022 (probe 404), FR-034 (empty states), FR-030 (copy-to-clipboard).

- [ ] T058 [P] [US2] Author failing contract test `tests/contract/members/list-members.test.ts` for `GET /api/members`
- [ ] T059 [P] [US2] Author failing integration test `tests/integration/members/directory-search.test.ts` — seeds 50 members, asserts substring + filter combinations + pagination cursor
- [ ] T060 [P] [US2] Author failing perf test `tests/integration/members/search-perf.test.ts` (gated by `RUN_PERF=1`, critique E5) — seeds 5,000 members under 2 tenants; asserts substring p95 < 500ms (SC-002)
- [ ] T061 [P] [US2] Author failing E2E spec `tests/e2e/members-directory-search.spec.ts @f3 @a11y @i18n`
- [ ] T062 [P] [US2] Implement `src/modules/members/application/use-cases/directory-search.ts` — substring search + filter compose + cursor pagination
- [ ] T063 [US2] Implement API route `src/app/api/members/route.ts` (GET list) with RBAC admin + manager read
- [ ] T064 [US2] Implement directory page `src/app/(staff)/admin/members/page.tsx` with shimmer skeleton in final table shape (CLS 0) + the **three distinct FR-034 empty states**: (a) **zero members** (onboarding CTA "Add your first member" + illustration) · (b) **filter yields zero** ("No members match these filters" + Clear-filters CTA) · (c) **server error** (5xx or network — retry button + localized message); inline 4xx errors render as banner, not empty-state page
- [ ] T065 [US2] Implement `src/app/(staff)/admin/members/_components/members-table.tsx` — TanStack Table v8 headless + shadcn Table visual primitives; placeholder `member_risk_flag` column rendering "—" per FR-001 note + US2 AS5
- [ ] T066 [US2] Implement `src/app/(staff)/admin/members/_components/directory-filters.tsx` with URL-state sync per US2 AS2 (bookmarkable filters)
- [ ] T067 [US2] Implement detail page `src/app/(staff)/admin/members/[memberId]/page.tsx` — member info + contacts grouped primary/secondary + FR-030 copy-to-clipboard buttons on member_id/email/tax_id
- [ ] T068 [US2] Implement API route `src/app/api/members/[memberId]/route.ts` (GET) with FR-022 404 + `member_cross_tenant_probe` audit
- [ ] T069 [US2] Extend `src/components/command-palette/` with Members group (research § 8) — RBAC-aware visibility; FR-043 ordering (exact → prefix → substring, then recency)
- [ ] T070 [US2] Fill i18n `admin.members.directory.*`, `admin.members.emptyStates.*` across EN/TH/SV

---

## Phase 5: User Story 3 — Edit member, plan, contacts + bundle-change warning (P2)

**Story goal**: Admin edits member details, plan, contacts with warnings for turnover / age / bundle change backed by real member counts.
**Independent test**: Open existing Premium Corporate member, change plan to Regular, update primary contact email, add secondary, save — verify validation + audit events + email-change transaction (when applicable).
**US3 requirements covered**: FR-004, FR-006/a, FR-007, FR-008, FR-009a, FR-010, FR-011, FR-012, FR-012a, FR-012b, FR-012c, SC-008 (bundle count perf).

### Tests-first

- [ ] T071 [P] [US3] Author failing contract test `tests/contract/members/update-member.test.ts` + `tests/contract/members/update-contact.test.ts` + `tests/contract/members/promote-primary.test.ts` + `tests/contract/members/affected-members.test.ts`
- [ ] T072 [P] [US3] Author failing integration test `tests/integration/members/contact-email-change-atomic.test.ts` covering FR-012a 6-step txn + 3 chaos sub-scenarios (outbox insert throws / session revocation throws / user email conflict — critique E13)
- [ ] T073 [P] [US3] Author failing integration test `tests/integration/members/email-change-dual-channel.test.ts` (FR-012b) — revert token within 48h rolls back + emits `member_email_change_reverted` + flags `requires_password_reset`
- [ ] T074 [P] [US3] Author failing integration test `tests/integration/members/outbox-permanent-failure.test.ts` (FR-012c) — simulated Resend 5xx on all 5 retries; verifies permanent_failed + `email_dispatch_failed` audit + admin re-send action
- [ ] T075 [P] [US3] Author failing integration test `tests/integration/members/primary-contact-race.test.ts` (edge case)
- [ ] T076 [P] [US3] Author failing integration test `tests/integration/members/bundle-change-warning.test.ts` — assert `GET /api/plans/[year]/[planId]/affected-members` p95 < 200ms at 500-member tenant (SC-008)
- [ ] T077 [P] [US3] Author failing E2E spec `tests/e2e/members-edit-with-bundle-warning.spec.ts @f3 @a11y @i18n`

### Application + Infrastructure

- [ ] T078 [P] [US3] Implement `application/use-cases/update-member.ts` with diff tracking for audit payload
- [ ] T079 [P] [US3] Implement `application/use-cases/change-plan.ts` handling override + bundle detection
- [ ] T080 [US3] Implement `application/use-cases/change-contact-email.ts` — full FR-012a 6-step atomic txn orchestrating `ContactRepo`, `SessionRevocationPort`, `EmailPort` outbox enqueue (verification + dual-channel notification). **Depends on T086 + T088 adapter landings** (removed [P] marker — orchestrates ports implemented there)
- [ ] T081 [P] [US3] Implement `application/use-cases/revert-contact-email.ts` (FR-012b) — validates token, rolls back atomically, flags `requires_password_reset`
- [ ] T082 [P] [US3] Implement `application/use-cases/resend-verification-email.ts` (FR-012c)
- [ ] T083 [P] [US3] Implement `application/use-cases/promote-primary-contact.ts` handling partial-index race with 409 mapping
- [ ] T084 [P] [US3] Implement `application/use-cases/add-contact.ts` + `update-contact.ts` + `remove-contact.ts`
- [ ] T085 [P] [US3] Implement `application/use-cases/affected-members-count.ts` — tenant-scoped COUNT with indexed lookup for FR-010 / SC-008
- [ ] T086 [US3] Implement adapter `infrastructure/adapters/auth-session-revocation-port.ts` importing from `@/modules/auth` barrel only
- [ ] T087 [US3] Implement adapter `infrastructure/adapters/plan-lookup-adapter.ts` importing from `@/modules/plans` barrel only
- [ ] T088 [US3] Implement adapter extensions to `resend-email-port.ts` adding `email_verification` + `email_change_revert` notification types with 5-minute activation delay for verification
- [ ] T089 [US3] Extend outbox dispatcher (F1) retry budget config for F3 notification types per spec § Security 4.2

### Presentation

- [ ] T090 [US3] Implement API route `src/app/api/members/[memberId]/route.ts` (PATCH) — handles member fields + plan change + 409 `bundle_change_requires_confirmation` on unconfirmed bundle change
- [ ] T091 [US3] Implement API route `src/app/api/members/[memberId]/contacts/route.ts` (POST add, GET list) + `[contactId]/route.ts` (PATCH, DELETE) + `[contactId]/promote-primary/route.ts` + `[contactId]/resend-verification/route.ts` (endpoint #15)
- [ ] T092 [US3] Implement API route `src/app/api/plans/[year]/[planId]/affected-members/route.ts` — imports use case from `@/modules/members`, RBAC admin-only
- [ ] T093 [US3] Implement public API route `src/app/api/auth/email-change/revert/[token]/route.ts` (endpoint #16) — no session; token-only auth; 5-attempts/10-min rate limit
- [ ] T094 [US3] Implement edit page `src/app/(staff)/admin/members/[memberId]/edit/page.tsx` wrapping `member-form.tsx` with Save → bundle-change detection
- [ ] T095 [US3] Implement `_components/bundle-change-warning-dialog.tsx` — fetches live count from endpoint #11; shows old/new bundle names; required confirmation (FR-010)
- [ ] T096 [US3] Implement public revert landing page `src/app/auth/email-change/revert/[token]/page.tsx` with clear "revert + set new password" CTA + FR-037 title
- [ ] T097 [US3] Implement admin help copy "Emergency primary contact transfer — use Add contact → Promote" as a Tooltip/Popover on the contact-list toolbar per spec Edge Cases
- [ ] T098 [US3] Fill i18n `admin.members.edit.*`, `admin.members.bundleChangeWarning.*`, `auth.emailChangeRevert.*`, `admin.members.emailChange.*` across EN/TH/SV

---

## Phase 6: User Story 4 — Inline edit + bulk actions (P2)

**Story goal**: Admin multi-selects rows and applies bulk change-plan / archive / send-invite; ≤100 rows per batch; 10 ops per 10 min per actor.
**Independent test**: Select 3 rows, choose "Archive selected", confirm, verify 3 status changes + audits.
**US4 requirements covered**: FR-018, FR-019, FR-019a, FR-019b, FR-040, FR-041, FR-042.

- [ ] T099 [P] [US4] Author failing contract test `tests/contract/members/bulk-action.test.ts` covering cap + rate-limit + action variants
- [ ] T100 [P] [US4] Author failing integration test `tests/integration/members/bulk-action-cap.test.ts` — 101-row submission → 400 `bulk_cap_exceeded`
- [ ] T101 [P] [US4] Author failing integration test `tests/integration/members/bulk-action-rate-limit.test.ts` — 11th action in 10min → 429 + `bulk_action_rate_limit_exceeded` audit
- [ ] T102 [P] [US4] Author failing integration test `tests/integration/members/inline-edit.test.ts` — optimistic update + rollback on server error
- [ ] T103 [P] [US4] Author failing E2E spec `tests/e2e/members-bulk-actions.spec.ts @f3 @a11y @i18n` incl. typed-phrase confirmation for >5 rows
- [ ] T104 [P] [US4] Implement `application/use-cases/bulk-action.ts` — single transaction over ≤100 rows + N audit events; all-or-nothing
- [ ] T105 [P] [US4] Implement `application/use-cases/inline-edit.ts` — whitelisted fields (status, country, notes) with optimistic semantics
- [ ] T106 [US4] Extend Upstash rate-limit adapter (F1) with per-actor token bucket `(tenant_id, user_id) → 10 / 10 min` key shape
- [ ] T107 [US4] Implement API route `src/app/api/members/bulk/route.ts` — cap + rate-limit + all-or-nothing + audit emission
- [ ] T108 [US4] Enhance `members-table.tsx` with TanStack Table row-selection state + Shift+Click range + Space toggle + Ctrl+A page + "Select all N matching" (FR-040)
- [ ] T109 [US4] Implement `_components/bulk-action-bar.tsx` sticky-bottom toolbar + `scroll-margin-bottom` (ADOPT-01 / WCAG 2.2 SC 2.4.11) + "N selected" counter + Clear affordance
- [ ] T110 [US4] Implement `_components/archive-confirm-dialog.tsx` with typed-phrase confirmation pattern when > 5 rows (US4 AS3)
- [ ] T111 [US4] Implement `_components/bulk-progress-indicator.tsx` for > 1-second operations (FR-041) via SSE or short-poll
- [ ] T112 [US4] Add inline-edit cells to `members-table.tsx` for status/country/notes with aria-live save/rollback announcements + 24×24 min target size (ADOPT-01 / WCAG 2.2 SC 2.5.8)
- [ ] T113 [US4] Fill i18n `admin.members.bulk.*`, `admin.members.inlineEdit.*` across EN/TH/SV

---

## Phase 7: User Story 5 — Member self-service portal (P2)

**Story goal**: Signed-in member views + edits whitelisted fields of own profile + invites colleague.
**Independent test**: Sign in as member, view profile, update phone, save — verify audit + forbidden-field rejection.
**US5 requirements covered**: FR-013, FR-014, FR-014a, FR-015, FR-042.

- [ ] T114 [P] [US5] Author failing contract test `tests/contract/portal/profile.test.ts` covering GET + PATCH + forbidden-field 403
- [ ] T115 [P] [US5] Author failing integration test `tests/integration/members/self-service-whitelist.test.ts` — forged payload with `plan_id` / `status` / `tax_id` → 403 + `member_self_update_forbidden` audit
- [ ] T116 [P] [US5] Author failing unit test `tests/unit/members/application/whitelist-schema-equals-tuple.test.ts` (FR-014a — zod key set === tuple)
- [ ] T117 [P] [US5] Author failing E2E spec `tests/e2e/members-self-service.spec.ts @f3 @a11y @i18n`
- [ ] T118 [P] [US5] Implement `application/use-cases/member-self-update.ts` with tuple-generated zod schema
- [ ] T119 [P] [US5] Implement `application/use-cases/invite-colleague.ts` primary-contact-only gating
- [ ] T120 [US5] Implement API route `src/app/api/portal/profile/route.ts` (GET + PATCH) with member-only RBAC + session-derived member resolution
- [ ] T121 [US5] Implement API route `src/app/api/portal/contacts/invite/route.ts` primary-contact-only
- [ ] T122 [US5] Replace F1 placeholder shell with real `src/app/(member)/portal/layout.tsx`
- [ ] T123 [US5] Implement `src/app/(member)/portal/page.tsx` — Profile view with the 3 real surfaces only (FR-042 — forbidden fields hidden entirely, not disabled)
- [ ] T124 [US5] Implement `src/app/(member)/portal/edit/page.tsx` — whitelisted-field form
- [ ] T125 [US5] Implement `src/app/(member)/portal/contacts/invite/page.tsx` — colleague invite form
- [ ] T126 [US5] Fill i18n `portal.profile.*`, `portal.invite.*` across EN/TH/SV

---

## Phase 8: User Story 6 — Per-member Timeline (P3)

**Story goal**: Member detail page shows chronological audit feed with pagination.
**Independent test**: Perform 5 actions on a member, open Timeline, see 5 events newest-first with proper localization.
**US6 requirements covered**: FR-020, FR-023, FR-024 (a11y).

- [ ] T127 [P] [US6] Author failing contract test `tests/contract/members/timeline.test.ts`
- [ ] T128 [P] [US6] Author failing integration test `tests/integration/members/timeline.test.ts` covering cursor pagination + member-role redaction + reduced-motion
- [ ] T129 [P] [US6] Author failing E2E spec `tests/e2e/members-timeline.spec.ts @f3 @a11y @i18n`
- [ ] T130 [P] [US6] Implement `application/use-cases/timeline-list.ts` — queries `audit_log` with `payload->>'member_id' = $1` + cursor pagination
- [ ] T131 [US6] Implement API route `src/app/api/members/[memberId]/timeline/route.ts`
- [ ] T132 [US6] Implement timeline page `src/app/(staff)/admin/members/[memberId]/timeline/page.tsx` using Cache Components + `cacheTag('member', memberId)` per research § 9; reduced-motion fallback per FR-044
- [ ] T133 [US6] Fill i18n `audit.eventType.*` display strings for all 20+ audit event types across EN/TH/SV

---

## Phase 9: User Story 7 — Archive + undelete (P3)

**Story goal**: Admin archives a member; disappears from default directory; undelete within 90 days.
**Independent test**: Archive → disappears → toggle "Show archived" → appears → Undelete → reappears active with audit.
**US7 requirements covered**: FR-005, FR-027, spec US7 AS1–AS4.

- [ ] T134 [P] [US7] Author failing contract test `tests/contract/members/archive-undelete.test.ts`
- [ ] T135 [P] [US7] Author failing integration test `tests/integration/members/archive-cascade.test.ts` — archive cascades session revocation + invitation revocation per edge case
- [ ] T136 [P] [US7] Author failing integration test `tests/integration/members/undelete-window.test.ts` — 91-day archive → 403 `archive_window_expired`
- [ ] T137 [P] [US7] Author failing E2E spec `tests/e2e/members-archive-undelete.spec.ts @f3 @a11y`
- [ ] T138 [P] [US7] Implement `application/use-cases/archive-member.ts` — status flip + cascade (session revoke + invitation revoke) in single txn
- [ ] T139 [P] [US7] Implement `application/use-cases/undelete-member.ts` — 90-day window check + status flip
- [ ] T140 [US7] Implement API route `src/app/api/members/[memberId]/archive/route.ts` (POST) + `undelete/route.ts` (POST)
- [ ] T141 [US7] Implement `_components/archived-banner.tsx` + wire into detail page
- [ ] T142 [US7] Add "Show archived" filter toggle to directory (FR-034 edge case — third state) + disabled Undelete for > 90 days with tooltip
- [ ] T143 [US7] Fill i18n `admin.members.archive.*`, `admin.members.undelete.*` across EN/TH/SV

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Close the security.md checklist, finalize observability, run full CI, handoff artifacts.

### ADOPT-01 (WCAG 2.2 opportunistic adoption)

- [ ] T144 [P] Add axe-core `target-size` rule assertion to every `@a11y` spec (ADOPT-01 WCAG 2.2 SC 2.5.8)
- [ ] T145 [P] Author Playwright computed-style assertion in `tests/e2e/members-target-size-2-2.spec.ts @f3 @a11y` — enumerated sample targets: (i) inline-edit cells (status, country, notes), (ii) icon buttons on each directory row (archive, undelete, promote-primary, invite), (iii) multi-select header + row checkboxes, (iv) palette result rows, (v) close buttons on every dialog (bundle-warning, override-reason, soft-duplicate, archive-confirm), (vi) row-action dropdown triggers — all ≥ 24×24 CSS px per ADOPT-01 / WCAG 2.2 SC 2.5.8
- [ ] T146 [P] Author `tests/e2e/members-focus-not-obscured.spec.ts @f3 @a11y` — keyboard-only walk verifying no focus occlusion by sticky bulk toolbar (ADOPT-01 WCAG 2.2 SC 2.4.11)
- [ ] T146a [P] Author `tests/e2e/members-page-titles.spec.ts @f3 @a11y` — navigate every F3 route (`/admin/members`, `/admin/members/new`, `/admin/members/[id]`, `/admin/members/[id]/edit`, `/admin/members/[id]/timeline`, `/portal`, `/portal/edit`, `/portal/contacts/invite`, `/auth/email-change/revert/[token]`) and assert each emits a unique `<title>` per FR-037
- [ ] T146b [P] Author `tests/e2e/members-reduced-motion.spec.ts @f3 @a11y` — set `prefers-reduced-motion: reduce`; verify (i) shimmer skeleton renders as static pulse (not animated), (ii) palette open/close has no slide animation, (iii) toast appears instantly (no slide-in), (iv) timeline reveal is instant per FR-044

### Observability + Runbook

- [ ] T147 Flesh out `docs/observability.md § F3 Members` with metric names, SLO thresholds, PagerDuty alert config per plan § Constitution Check VII + security.md § 4
- [ ] T148 [P] Author `tests/e2e/members-a11y.spec.ts @f3 @a11y` comprehensive axe-core scan across every FR-024 surface
- [ ] T149 [P] Author `tests/e2e/members-i18n.spec.ts @f3 @i18n` locale coverage (EN + TH + SV) + Thai BE display on DOB + axe-core per locale

### i18n completeness

- [ ] T150 Run `pnpm check:i18n` and fix any missing EN/TH/SV keys until all 3 locales pass

### Full CI validation

- [ ] T151 Run local full CI pipeline: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm test:integration && pnpm test:e2e`
- [ ] T152 Confirm F1 test suite (480 tests) + F2 test suite (495 + 163 integration) remain green — SC-010

### Security checklist close-out

- [ ] T153 Tick each item in `specs/005-members-contacts/checklists/security.md` (78 items) with evidence links (commit SHA / test file path / screenshot)
- [ ] T154 Tick each item in `specs/005-members-contacts/checklists/ux.md` (88 items)
- [ ] T155 Tick each item in `specs/005-members-contacts/checklists/a11y.md` (95 items)
- [ ] T155a Manual screen-reader pass (NVDA on Windows OR VoiceOver on macOS) on `/admin/members` directory + `/portal` landing + `/admin/members/new` create form — verify logical reading order, correct role announcements on TanStack Table + Combobox + Calendar, inline-edit save announcements; attach transcript/recording to security.md § 5 evidence per FR-039
- [ ] T156 Maintainer co-signs `security.md § 5` checklist (solo-maintainer substitute requirement) — including attestation of T155a manual SR pass

### Performance validation

- [ ] T157 Run `RUN_PERF=1 pnpm test:integration -- search-perf.test.ts` and confirm SC-002 (p95 < 500ms @ 5k rows)
- [ ] T158 Measure `members` API p95 / p99 on staging via `@vercel/otel` traces — confirm < 400ms / < 800ms (Principle VII)

### Documentation

- [ ] T159 Update `CLAUDE.md` Active Technologies + Recent Changes sections via `update-agent-context.ps1` (one final run post-implementation)
- [ ] T160 Author retrospective at `specs/005-members-contacts/retrospective.md` matching the F2 format

---

## Dependencies & Story Completion Order

```
Phase 1 Setup  (T001-T006, all parallelizable)
    ↓
Phase 2 Foundational  (T007-T039, schema+domain+ports+RBAC+flag)
    ↓
Phase 3 US1 (P1) Create member       ─┐
Phase 4 US2 (P1) Directory search    ─┤  MVP slice complete
                                       │  (Excel replacement ready)
                                      ─┘
    ↓
Phase 5 US3 (P2) Edit + bundle + email-change
    ↓
Phase 6 US4 (P2) Inline + bulk    ←── depends on US2 directory + TanStack Table
    ↓
Phase 7 US5 (P2) Self-service     ←── depends on US3 (contact-email txn for portal invites)
    ↓
Phase 8 US6 (P3) Timeline         ←── depends on audit events from US1-US5
Phase 9 US7 (P3) Archive/undelete ←── can run in parallel with US6 after US3
    ↓
Phase 10 Polish & cross-cutting   ←── ADOPT-01 + runbook + full-CI + checklist close-out
```

## Parallel Execution Opportunities

- **Phase 1 Setup**: T001–T006 all independent → run in parallel
- **Phase 2 Domain types** (T017–T031): all value objects / policies in different files → parallel block
- **Phase 2 Tests** (T007, T012, T013, T032, T035, T037): author in parallel before implementation lands
- **Each US tests-first block** (e.g., US1 T040–T043, US3 T071–T077, US4 T099–T103): parallel authoring
- **Use-case implementations within a story** (marked [P]): usually parallel if different files
- **Polish phase test authoring** (T144–T149): parallel

## Independent Test Criteria (per story)

| Story | Independent test |
|---|---|
| US1 | Admin creates new member with primary contact in ≤ 90 s; directory shows new row with correct plan; `member_created` audit event emitted |
| US2 | Directory search `"Fog"` narrows to matching members ≤ 500 ms; plan+country filter; row click → detail page loads with all contacts + Timeline tab visible |
| US3 | Partnership plan bundle change shows live member count in dialog; save → PATCH fires; email change revokes sessions + dispatches verification + OLD-email revert notification |
| US4 | Select 3 rows → archive → all 3 disappear from default directory; try 101 rows → blocked at UI; try 11th bulk in 10 min → 429 toast |
| US5 | Sign in as member, view own profile, update phone, save → `member_self_updated` audit; forged `plan_id` payload → 403 + `member_self_update_forbidden` |
| US6 | Perform 5 actions on a member → Timeline shows 5 events newest-first with localized labels + BE display for `th-TH` |
| US7 | Archive member → disappears from default directory + linked user sessions dead + pending invitation revoked; Undelete within 90 d → reappears active |

## MVP Scope

**Phase 1 + Phase 2 + Phase 3 (US1) + Phase 4 (US2)** = Excel-replacement baseline. Ships all P1 stories with tenant isolation, RLS, audit trail, command palette, and directory search.

Phases 5–9 ship incrementally within the same branch as smart-feature + self-service + archival capabilities. Phase 10 closes gate + handoff.

## Format Validation

All tasks follow the strict format `- [ ] Tnnn [P?] [USx?] Description with exact file path`. Checklist ✓, Task IDs T001–T160 ✓, Story labels US1–US7 applied in Phases 3–9 only ✓, Setup/Foundational/Polish omit story labels ✓, Every task includes a file path or observable action ✓.
