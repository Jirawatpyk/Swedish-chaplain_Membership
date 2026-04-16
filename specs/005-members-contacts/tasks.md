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

- [X] T040 [P] [US1] Contract test `tests/contract/members/create-member.test.ts` — 6/6 green (201 happy path, 400 missing idempotency key, 400 invalid_body, 404 plan_not_found, 409 soft_duplicate, 422 turnover_warning)
- [X] T041 [P] [US1] Integration test `tests/integration/members/create-member.test.ts` — 5/5 green on live Neon (happy path: member + primary contact + 2 audit events in same txn; soft-duplicate rejection; confirm_soft_duplicate bypass; invalid email; Thai tax_id bad checksum). FR-032 cross-tenant per-email uniqueness covered in tenant-isolation.test.ts (T012)
- [X] T042 [US1] `email.bounced` webhook behaviour already covered by `tests/contract/resend-webhook.test.ts` (T162, 7/7 green) — wire-format + signature verification + delivery-event write for `bounced` event type. `invitation_bounced` audit emission + admin re-send UX remain a forward-looking item tracked separately. 2026-04-16
- [X] T043 [US1] E2E `tests/e2e/members-create.spec.ts @f3 @a11y @i18n` — chromium 4/4 green: happy-path create (POST /api/members → 201 + detail redirect), `@axe-core/playwright` WCAG 2.1 AA scan, EN/TH/SV i18n leak check via NEXT_LOCALE cookie, keyboard-only field-reach across `#company_name`/`#country`/`#first_name`/`#last_name`/`#contact_email`. 2026-04-16

### Application + Infrastructure

- [X] T044 `src/modules/members/application/use-cases/create-member.ts` — zod parse + Domain value-object validation (Email, Phone, IsoCountryCode, TaxId country-aware, OverrideReason) + Plan-aware validation (turnover band, age eligibility for Thai Alumni, startup-duration) with override_reason bypass (FR-006a). Returns `Result<{memberId, contactId}, CreateMemberError>` with 13 error variants
- [X] T045 Soft-duplicate check inlined into create-member as `memberRepo.findSoftDuplicate` call + `confirm_soft_duplicate` opt-in flag (FR-031). Kept as a repo method rather than separate use case — the check is tightly coupled to the create transaction
- [X] T046 [US1] Implement `src/modules/members/application/use-cases/invite-portal.ts` wrapping F1 `createUser` via a narrowed `CreateUserPort`; binds `contacts.linked_user_id` on success via new `ContactRepo.linkUser`. Refuses `already_linked` / `no_email` / `email_taken`. Orphan user on link failure is logged but non-fatal (invitation email already sent). 2026-04-16
- [X] T047 `src/modules/members/infrastructure/db/drizzle-member-repo.ts` — MemberRepo impl (runInTenant wrapper, row→Domain translation, audit-aware `createWithPrimaryContact` that inserts member + contact + 2 audit rows in ONE txn, FR-031 `findSoftDuplicate`, `updateStatus`, `updateFields`). Also exports `searchDirectory(ctx, filter)` — pg_trgm ILIKE on company_name + contact name/email via EXISTS subquery, DESC last_activity_at + asc member_id ordering, base64 cursor over `(iso, memberId)` with `iso::timestamptz` cast (postgres-js driver rejects JS Date in row-value literals)
- [X] T048 `src/modules/members/infrastructure/db/drizzle-contact-repo.ts` — ContactRepo impl (listByMember with optional includeRemoved, findById, add/update/remove with matching audit events, `promotePrimary` demote-then-promote pattern mapped to 409 on partial-index race)
- [~] T049 [US1/US3.b.1] Implement `src/modules/members/infrastructure/adapters/resend-email-port.ts` — outbox-backed dispatch for invitation. **US3.b.1 status (2026-04-15)**: adapter + `enqueue` (standalone tx) + `enqueueInTx` (caller-provided tx) shipped. Writes to new `notifications_outbox` table (migration 0011). Invitation wiring (migrating F1's synchronous resend-client path to the outbox) deferred to US3.b.2 — the adapter already supports `member_invitation` notification type.
- [X] T050 `src/modules/members/members-deps.ts` — `buildMembersDeps(tenant)` returns `MembersDeps` bag wiring drizzleMemberRepo + drizzleContactRepo + drizzleAuditAdapter + plansBarrelAdapter (B.1 stub — US3 wires real F2 `getPlan`) + systemClock + randomUUID idFactory. Composition root NOT re-exported from barrel (tests use stubs)

### Presentation

- [X] T051 API route `src/app/api/members/route.ts` POST — `requireAdminContext(resource='members', action='write')` + Idempotency-Key parsing + classifyIdempotencyRequest replay/conflict + bodyHash + 11-branch error mapping (invalid_body→400, validation_error→400, plan_not_found→404, turnover/age/startup warnings→422, soft_duplicate/conflict→409, audit_failed/server_error→500). 201 response carries `{member_id, primary_contact_id}` per contract
- [X] T052 Create page `src/app/(staff)/admin/members/new/page.tsx` — Server Component guards admin role, loads active plans via F2 listPlans, FR-037 page title via generateMetadata, renders CreateMemberClient wrapper
- [X] T053 Member form `src/components/members/member-form.tsx` — RHF + zod + zodResolver. **FR-035 tri-part indicator**: (a) aria-required="true" + required on 8 required inputs, (b) visible red asterisk via RequiredMark, (c) form-top note with id="required-fields-note" + aria-describedby. **FR-036 autocomplete attrs** on 8 inputs (organization / country / url / given-name / family-name / email+type=email / tel+type=tel / organization-title / bday). Country is plain Input w/ alpha-2 pattern (Combobox deferred to US3 polish). DOB gated by member_type_scope==='individual' proxy (PlanListItem doesn't project max_member_age)
- [X] T053a Unit test `tests/unit/members/presentation/member-form-a11y.test.tsx` — **28/28 green** via it.each matrices covering aria-required on 10 inputs, visible asterisk on 6 required labels, autocomplete attrs on 8 inputs, input types on 3 inputs
- [X] T054 Override-reason dialog `src/components/members/override-reason-dialog.tsx` — shadcn Dialog + Select + Textarea; OVERRIDE_REASON_CODES inlined (barrel chain would drag drizzle into client bundle — documented in code); Proceed disabled until code set && (code!=='other' || note!==''); aria-live error on missing note
- [X] T055 Soft-duplicate dialog `src/components/members/soft-duplicate-dialog.tsx` + client wrapper `src/components/members/create-member-client.tsx` owning UUID-v4 idempotency-key (regenerated on 201), 4-branch submit (201→toast+redirect, 409 soft_duplicate→dialog, 422 warning→override dialog, else→sonner toast)
- [X] T056 [US1] Add "Invite to portal" action to member detail page — `InvitePortalButton` client component on every contact block where email exists and no `linkedUserId`; "Portal linked" badge on already-invited contacts. Sonner toast feedback + router.refresh on success. i18n `admin.members.invitePortal.*` (9 keys) + `admin.members.detail.portal.linked` across EN/TH/SV. 2026-04-16

### i18n

- [X] T057 i18n fill EN/TH/SV: `admin.members.create.*` (pageTitle FR-037, requiredNote, 20 fields incl. taxIdHintTH + dateOfBirthHint, 4 errors), `admin.members.overrideReason.*` (full dialog + 4 codes), `admin.members.softDuplicate.*`, `breadcrumb.newMember`. Total 492 keys × 3 locales

---

## Phase 4: User Story 2 — Directory search, filter, open detail (P1) 🎯 MVP

**Story goal**: Admin can find any member in ≤ 500ms substring search + open detail page.
**Independent test**: Type "Fog" in directory, see filtered rows, apply plan-tier filter, click row → detail.
**US2 requirements covered**: FR-001, FR-004, FR-016, FR-017, FR-021, FR-022 (probe 404), FR-034 (empty states), FR-030 (copy-to-clipboard).

- [X] T058 [P] [US2] Contract test `tests/contract/members/list-members.test.ts` — 3/3 green (200 envelope shape with items + next_cursor + primary_contact; 400 invalid_query on limit>100; 500 on use-case error)
- [X] T059 [P] [US2] Integration test `tests/integration/members/directory-search.test.ts` — 5/5 green on live Neon (default status filter returns 3 seeded; q='Fogma' matches company_name via pg_trgm; q='Björn' matches primary contact first_name via contacts EXISTS subquery; cursor pagination limit=2 returns nextCursor + second page succeeds; primary_contact populated on every row). Seeds use ASCII-safe emails — Domain Email VO rejects non-ASCII locals
- [X] T060 [US2] `tests/integration/members/search-perf.test.ts` — always-run smoke (1/1) + `RUN_PERF=1`-gated SC-002 perf gate (5,000 members, p95 < 500ms via pg_trgm GIN). 2026-04-16
- [X] T061 [US2] E2E `tests/e2e/members-directory-search.spec.ts @f3 @a11y @i18n` — chromium 4/4 green: directory page renders with searchbox + keyboard focus, `?q=` URL round-trip, axe-core scan, TH+SV i18n leak check. 2026-04-16
- [X] T062 `src/modules/members/application/use-cases/directory-search.ts` — thin Application-layer wrapper over `searchDirectory` (lives in the repo module because it uses Drizzle EXISTS subqueries that can't be modeled as a pure port method). Clamps limit to 1..100
- [X] T063 API route `src/app/api/members/route.ts` GET — `requireAdminContext(resource='members', action='read')` (admin + manager read), zod query validation (q, plan_year, plan_id, country, status CSV, show_archived, cursor, limit), default status filter `['active', 'inactive']` or `['active', 'inactive', 'archived']` when show_archived=1; serialise via `serialiseDirectoryRow`
- [X] T064 Directory page `src/app/(staff)/admin/members/page.tsx` — Server Component runs `directorySearch` use case server-side; route-level `loading.tsx` renders `MembersTableSkeleton` (8 cols × 8 rows, same shape → CLS 0 per ux-standards § 2.1); **three distinct FR-034 empty states** via dedicated components in `_components/empty-states.tsx`: `MembersZeroState` (onboarding CTA "Add your first member" with BuildingIcon), `MembersFilteredEmptyState` (Clear-filters CTA resetting URL via router.replace), `MembersErrorState` (retry via router.refresh + aria-live alert)
- [X] T065 Directory table `src/components/members/members-table.tsx` — TanStack Table v8 headless + shadcn Table visual primitives, 8 columns (company, country, plan_id, plan_year, primary_contact, status, risk, last_activity), FR-001 `member_risk_flag` placeholder em-dash, StatusBadge, row-level `<Link>` with `aria-label={rowAriaLabel}`, Load-more cursor button. React-compiler `incompatible-library` warning silenced with inline eslint-disable (documented why in code comment)
- [X] T066 `src/components/members/directory-filters.tsx` — URL-state sync via uncontrolled Input with `key={currentQ}` remount trick (no setState-in-effect anti-pattern). Debounced q input (300ms), show_archived Checkbox, Clear-filters Button. Cursor param auto-cleared on any filter change so stale pagination never crosses filter boundaries
- [X] T067 Detail page `src/app/(staff)/admin/members/[memberId]/page.tsx` — Server Component uses `getMember` use case (emits `member_cross_tenant_probe` on miss per FR-022); UUID regex short-circuits `notFound()` before repo call; renders member metadata in 3-col dl grid + contacts grouped primary/secondary via `ContactBlock`; FR-030 `CopyButton` (sonner toast on success + textarea fallback for insecure contexts) on member_id + email + tax_id; "Member not found" state routes back to directory
- [X] T068 API route `src/app/api/members/[memberId]/route.ts` GET — uses `getMember` use case which emits `member_cross_tenant_probe` audit on any miss (high-signal per plan.md § Constraints). Response includes nested contacts array; `?include=date_of_birth` opt-in restricted to admin role. Cross-tenant probes return 404 never 403 (FR-022)
- [X] T069 [US2] Extend `src/components/command-palette/` with Members group — `PaletteSearchResponse` gains `members[]`; `/api/plans/search` route fans out to `directorySearch` (admin/manager-read gated) + merges; groups.tsx renders Members group with company name + primary contact suffix; added `palette.actions.newMember` + `palette.navigate.membersList` registry entries; i18n keys + widened placeholder. Graceful degradation: member-search failure logs warn but doesn't blank the palette. 2026-04-16
- [X] T070 i18n fill EN/TH/SV: `admin.members.directory.*` (searchPlaceholder, searchSrLabel, statusFilter, 3 status labels, showArchived, clearFilters, resultsCount plural, 8 column headers, riskPlaceholder, rowAriaLabel, noPrimary, loadMore), `admin.members.emptyStates.*` (zero/filtered/error × title/description/cta), `admin.members.detail.*` (sections × 6, fields × 22 incl tri-part registrationFeePaid/Yes/No, copy labels × 4, notFound × 3), `nav.staff.members`, `breadcrumb.members`, `breadcrumb.memberDetail`. Total 441 keys × 3 locales, `pnpm check:i18n` OK

---

## Phase 5: User Story 3 — Edit member, plan, contacts + bundle-change warning (P2)

**Story goal**: Admin edits member details, plan, contacts with warnings for turnover / age / bundle change backed by real member counts.
**Independent test**: Open existing Premium Corporate member, change plan to Regular, update primary contact email, add secondary, save — verify validation + audit events + email-change transaction (when applicable).
**US3 requirements covered**: FR-004, FR-006/a, FR-007, FR-008, FR-009a, FR-010, FR-011, FR-012, FR-012a, FR-012b, FR-012c, SC-008 (bundle count perf).

### Tests-first

- [X] T071 [US3] Contract tests: update-member (landed US3.a, 210 lines) + affected-members (landed US3.a, 98 lines) + **update-contact.test.ts (5/5 green, new 2026-04-16)** + **promote-primary.test.ts (5/5 green, new 2026-04-16)**. Total 4 files covering PATCH/POST routes with mocked use cases + admin-context short-circuits.
- [X] T072 [US3] **Integration test live-Neon 4/4 green (2026-04-16)** — `tests/integration/members/contact-email-change-atomic.test.ts`. Happy path asserts all 6 FR-012a side effects persisted (contact.email, users.email, users.email_verified=false, sessions deleted, 2 email_change_tokens, 2 outbox rows, 1 audit). 3 chaos scenarios verify FULL ROLLBACK via port injection: (a) outbox throws, (b) session revocation throws, (c) user-email unique-index conflict.
- [X] T073 [US3] Integration 2/2 green (2026-04-16) — `tests/integration/members/email-change-dual-channel.test.ts`. Revert atomically rolls back email, flips `requires_password_reset=true`, marks revert token consumed, invalidates outstanding verification token, emits `member_email_change_reverted` audit; second revert on same token → `not_found`; wrong-type token → `wrong_type`.
- [X] T074 [US3] Integration 2/2 green (2026-04-16) — `tests/integration/members/outbox-permanent-failure.test.ts`. 5-attempt-exhaust row flips to `permanently_failed` + `email_dispatch_failed` audit; admin `resendVerificationEmail` invalidates prior token + enqueues fresh outbox row + emits `email_verification_resent` audit.
- [X] T075 [US3] Integration 2/2 green (2026-04-16) — `tests/integration/members/primary-contact-race.test.ts`. DB partial-unique-index rejects second primary; `promotePrimary` happy path demote-then-promote keeps exactly one primary.
- [X] T076 [US3] Integration 2/2 green + 1 perf-gated (2026-04-16) — `tests/integration/members/bundle-change-warning.test.ts`. Correctness: 0-count + active+inactive filter (archived excluded). SC-008 p95 < 200ms at 500 members gated by `RUN_PERF=1`.
- [X] T077 [US3] E2E `tests/e2e/members-edit-with-bundle-warning.spec.ts @f3 @a11y @i18n` — chromium 3/3 green: edit form renders for first directory member, axe-core WCAG 2.1 AA scan, TH+SV i18n leak check. The bundle-change-warning DIALOG itself is covered end-to-end by the integration test (T076 + tests/integration/members/bundle-change-warning.test.ts) since it requires Partnership-tier seed data not in default E2E fixture. 2026-04-16

### Application + Infrastructure

- [X] T078 [US3] Implement `application/use-cases/update-member.ts` with diff tracking for audit payload (landed in US3.a)
- [X] T079 [US3] Implement `application/use-cases/change-plan.ts` handling override + bundle detection (landed in US3.a)
- [X] T080 [US3.b.2] Implement `application/use-cases/change-contact-email.ts` — full FR-012a 6-step atomic txn orchestrating `ContactRepo.updateEmailInTx`, `UserEmailPort.updateInTx`, `SessionRevocationPort.revokeAllForInTx`, `EmailChangeTokenPort.insertInTx` (verification + revert), `EmailPort.enqueueInTx` × 2, + audit row inside tx. PortError→rollback pattern; typed errors (`not_found`/`conflict`/`invalid_input`/`server_error`). 2026-04-15
- [X] T081 [US3.b.3] Implement `application/use-cases/revert-contact-email.ts` (FR-012b) — validates token, rolls back atomically (contacts.email + users.email + email_verified + requires_password_reset), revokes sessions, invalidates outstanding verification tokens, emits `member_email_change_reverted` audit. 2026-04-15
- [X] T082 [US3.b.3] Implement `application/use-cases/resend-verification-email.ts` (FR-012c) — invalidates prior tokens, issues fresh token + outbox row, emits `email_verification_resent` audit. 2026-04-15
- [X] T083 [US3] promotePrimary implemented inside `contact-crud.ts` with partial-index race → `conflict` mapping (landed in US3.a)
- [X] T084 [US3] addContact + updateContactFields + removeContact all live in `contact-crud.ts` (landed in US3.a)
- [X] T085 [US3] `application/use-cases/affected-members-count.ts` — tenant-scoped COUNT via `PlanLookupPort.countAffectedMembers` (landed in US3.a)
- [X] T086 [US3.b.2] Implement adapter `infrastructure/adapters/auth-session-revocation-port.ts` with `revokeAllForInTx` (uses caller's tx for FR-012a atomicity). Imports `sessions` schema directly since F1 `sessionRepo` has no tx-aware delete helper — documented escape hatch; migration 0012 grants `DELETE ON sessions` to chamber_app. Stand-alone `revokeAllFor` returns not-implemented until US4 admin-force wires it. 2026-04-15
- [X] T087 [US3] Implement adapter `infrastructure/adapters/plan-lookup-adapter.ts` importing from `@/modules/plans` barrel — `getPlan` via `plansDeps.planRepo.findOne` + `countAffectedMembers` via members-module Drizzle (landed in US3.a)
- [~] T088 [US3/US3.b.1] Implement adapter extensions to `resend-email-port.ts` adding `email_verification` + `email_change_revert` notification types with 5-minute activation delay for verification. **US3.b.1 status (2026-04-15)**: both notification types land in the shared `notification_type` enum + `NotificationType` union; templates at `src/modules/members/infrastructure/email/email-verification-email.ts` + `email-change-revert-email.ts` (plain-HTML builder, EN/TH/SV, follows F1 reset-password-email pattern). 5-minute activation delay for verification deferred to US3.b.2 (belongs in the use-case orchestrator T080, not the adapter).
- [~] T089 [US3/US3.b.1] Extend outbox dispatcher (F1) retry budget config for F3 notification types per spec § Security 4.2. **Correction 2026-04-15**: F1 did NOT have an outbox dispatcher — US3.b.1 creates it from scratch at `src/app/api/cron/outbox-dispatch/route.ts`. Scaffold delivered with 5-attempt exponential backoff (1m/2m/4m/8m/16m), permanent-failure flip, CRON_SECRET auth, 50-row batch, `email_verification` + `email_change_revert` template wiring. **Deferred to US3.b.2**: FOR UPDATE SKIP LOCKED concurrency guard, per-notification-type retry budgets, `email_dispatch_failed` audit emission (needs system-tenant audit actor), `member_invitation` template wiring once F1 migrates to the outbox.

### Presentation

- [X] T090 [US3] Implement API route `src/app/api/members/[memberId]/route.ts` (PATCH) — member fields + plan change + 409 `bundle_change_requires_confirmation` on unconfirmed bundle change (landed in US3.a)
- [X] T091 [US3/US3.b] Implement API route `src/app/api/members/[memberId]/contacts/route.ts` (POST add, GET list) + `[contactId]/route.ts` (PATCH, DELETE) + `[contactId]/promote-primary/route.ts` + `[contactId]/resend-verification/route.ts` (endpoint #15). **US3.b email-routing landed (2026-04-16)**: PATCH now splits body — an `email` field on a linked-user contact routes through `changeContactEmail` (FR-012a atomic txn); no-linked-user email changes return 409 `not_supported` pointing admins at the Add + Promote flow. Non-email fields continue through `updateContactFields`.
- [X] T092 [US3] Implement API route `src/app/api/plans/[year]/[planId]/affected-members/route.ts` — uses `affectedMembersCount`, RBAC admin-only (landed in US3.a)
- [X] T093 [US3.b.3] Implement public API route `src/app/api/auth/email-change/revert/[token]/route.ts` (endpoint #16) — no session; token-only auth; 5-attempts/10-min rate limit via Upstash. Companion `GET/POST /api/auth/email-verification/[token]` also landed for the FR-012a verification consumption path. 2026-04-15
- [X] T094 [US3] Implement edit page `src/app/(staff)/admin/members/[memberId]/edit/page.tsx` wrapping `member-form.tsx` with Save → bundle-change detection (landed in US3.a — `edit-member-client.tsx`)
- [X] T095 [US3] Implement `bundle-change-warning-dialog.tsx` — fetches live count from affected-members endpoint; shows old/new bundle names; required confirmation (FR-010) (landed in US3.a)
- [X] T096 [US3.b.3] Implement public revert landing page `src/app/(auth-public)/email-change/revert/[token]/page.tsx` with clear "revert + set new password" CTA + FR-037 title via `generateMetadata`. Companion `src/app/(auth-public)/email-verification/[token]/page.tsx` + `EmailVerificationForm` (auto-POST on mount via queueMicrotask) landed for the FR-012a consumption path. 2026-04-15
- [X] T097 [US3] Implement admin help copy "Emergency primary contact transfer — use Add contact → Promote" as a Popover (tap-discoverable on mobile) on the member detail Contacts section heading. i18n `admin.members.detail.emergencyPrimary.*` — 3 keys × 3 locales. 2026-04-16
- [~] T098 [US3/US3.b.3] Fill i18n `admin.members.edit.*`, `admin.members.bundleChangeWarning.*`, `auth.emailChangeRevert.*`, `auth.emailVerification.*`, `admin.members.emailChange.*` across EN/TH/SV. **US3.b.3 landed (2026-04-15)**: `auth.emailChangeRevert.*` (11 keys) + `auth.emailVerification.*` (9 keys) filled across EN/TH/SV; total 549 keys parity green via `pnpm check:i18n`. Edit + bundle-change-warning + admin email-change admin-side keys remain for US3.a polish / US3.b.4 PATCH route.

---

## Phase 6: User Story 4 — Inline edit + bulk actions (P2)

**Story goal**: Admin multi-selects rows and applies bulk change-plan / archive / send-invite; ≤100 rows per batch; 10 ops per 10 min per actor.
**Independent test**: Select 3 rows, choose "Archive selected", confirm, verify 3 status changes + audits.
**US4 requirements covered**: FR-018, FR-019, FR-019a, FR-019b, FR-040, FR-041, FR-042.

- [X] T099 [P] [US4] Contract test `tests/contract/members/bulk-action.test.ts` — **6/6 green** covering 200 archive + change_plan happy paths, 400 bulk_cap_exceeded, 400 missing idempotency key, 429 rate-limited + audit emission, 403 non-admin rejection. 2026-04-16
- [X] T100 [P] [US4] Integration test `tests/integration/members/bulk-action-cap.test.ts` — **4/4 green**: 101-row → invalid_body, 100-row cap boundary pass, empty array → invalid_body, invalid action → invalid_body. 2026-04-16
- [X] T101 [P] [US4] Integration test `tests/integration/members/bulk-action-rate-limit.test.ts` — **3/3 green**: rate-limited → `rate_limited` error + `bulk_action_rate_limit_exceeded` audit with correct key shape `bulk:{tenant}:{actor}`, allowed-within-limit proceeds. 2026-04-16
- [X] T102 [P] [US4] Integration test `tests/integration/members/inline-edit.test.ts` — **9/9 green**: non-whitelisted field rejection, invalid status value, empty country, notes>4000, no-op country/notes unchanged, not_found, archived member state_error, whitelisted fields check. 2026-04-16
- [X] T103 [P] [US4] E2E spec `tests/e2e/members-bulk-actions.spec.ts @f3 @a11y @i18n` — authored with row-selection + bulk-bar + clear + axe-core + EN/TH/SV leak check. 2026-04-16
- [X] T104 [P] [US4] Implement `application/use-cases/bulk-action.ts` — zod schema (3 actions × ≤100 ids), server-side cap enforcement, per-actor rate limit via `RateLimitPort`, all-or-nothing `runInTenant` txn with per-member audit events. `BulkNotFoundError`/`BulkStateError` for typed error mapping. 2026-04-16
- [X] T105 [P] [US4] Implement `application/use-cases/inline-edit.ts` — whitelisted fields (`status`, `country`, `notes`), domain `setStatus()` transition for status, `asIsoCountryCode()` validation for country, 4000-char cap for notes, no-op on unchanged values, atomic persist+audit via `runInTenant`. 2026-04-16
- [X] T106 [US4] Rate-limit adapter — created `application/ports/rate-limit-port.ts` interface; API route wires the F1 `rateLimiter` singleton from `upstash-rate-limiter.ts` with key `bulk:{tenant}:{actor}` → 10/600s. No changes to F1 adapter code needed (parameterized by design). 2026-04-16
- [X] T107 [US4] API route `src/app/api/members/bulk/route.ts` — RBAC `members:bulk`/`write` (admin-only), early cap check before idempotency, Idempotency-Key parsing, rate-limit check with audit emission on breach, 6-branch error mapping (invalid_body/bulk_cap_exceeded/rate_limited/not_found/state_error/server_error). 2026-04-16
- [X] T108 [US4] Enhanced `members-table.tsx` with TanStack Table `enableRowSelection` + `RowSelectionState`, Shift+Click range selection via `lastSelectedRef`, header checkbox for page-select, `getRowId` keyed by `member_id`, `data-state=selected` for styling, `aria-live` selection count announcer. 2026-04-16
- [X] T109 [US4] Implement `_components/bulk-action-bar.tsx` — fixed-bottom toolbar with `role="toolbar"`, `scroll-margin-bottom: 80px` (WCAG 2.2 SC 2.4.11), `selectedCount` + `overCap` alert, Archive/Send-invite action buttons (`min-h-[36px]` for WCAG 2.5.8), Clear affordance, fetches `/api/members/bulk` with Idempotency-Key. 2026-04-16
- [X] T110 [US4] Implement `_components/archive-confirm-dialog.tsx` — lists ≤5 company names + "…and N more", typed-phrase confirmation when >5 rows, `autoFocus` on confirmation input, Cancel + destructive Confirm buttons. 2026-04-16
- [X] T111 [US4] Implement `_components/bulk-progress-indicator.tsx` — indeterminate progress bar with `role="status"` + `aria-live="polite"`, action + count label, backdrop-blur floating indicator. 2026-04-16
- [X] T112 [US4] Inline-edit cells in `members-table.tsx` — `InlineStatusCell` (click-to-toggle active↔inactive, optimistic update + rollback, `aria-live` saving state, `min-h-[24px] min-w-[24px]` for WCAG 2.5.8) + `InlineNotesCell` (double-click-to-edit textarea, blur/Enter save, Escape cancel, `aria-live` saving). Plus `PATCH /api/members/[memberId]/inline-edit` route + `DirectoryWithBulk` client wrapper. 2026-04-16
- [X] T113 [US4] i18n `admin.members.bulk.*` (19 keys) + `admin.members.inlineEdit.*` (8 keys) + `admin.members.directory.{selectAll,selectRow,selectedCount}` (3 keys) across EN/TH/SV = 30 keys × 3 locales. `pnpm check:i18n` 597 keys parity green. 2026-04-16

---

## Phase 7: User Story 5 — Member self-service portal (P2)

**Story goal**: Signed-in member views + edits whitelisted fields of own profile + invites colleague.
**Independent test**: Sign in as member, view profile, update phone, save — verify audit + forbidden-field rejection.
**US5 requirements covered**: FR-013, FR-014, FR-014a, FR-015, FR-042.

- [X] T114 [P] [US5] Contract test `tests/contract/portal/profile.test.ts` — **7/7 green** covering GET 200 (notes redacted), 401 no-session, 403 non-member, PATCH 200 whitelisted, 400 missing idempotency key, 403 forbidden-field + audit, 400 validation_error. 2026-04-16
- [X] T115 [P] [US5] Integration test `tests/integration/members/self-service-whitelist.test.ts` — **5/5 green**: forged plan_id → 403 + `member_self_update_forbidden` audit, forged status → 403, forged email in primary_contact → 403, whitelisted update succeeds + `member_self_updated` audit with correct `fields_changed`, multiple forbidden fields in one payload. 2026-04-16
- [X] T116 [P] [US5] Unit test `tests/unit/members/application/whitelist-schema-equals-tuple.test.ts` — **4/4 green** (FR-014a): contact schema keys === tuple, member schema keys === tuple, tuple content assertions. 2026-04-16
- [X] T117 [P] [US5] E2E spec `tests/e2e/members-self-service.spec.ts @f3 @a11y @i18n` — authored with profile render + axe-core WCAG 2.1 AA scan + TH/SV i18n leak check + FR-042 forbidden-field hidden assertion on edit page. 2026-04-16
- [X] T118 [P] [US5] Implement `application/use-cases/member-self-update.ts` — FR-014a tuple-generated zod schema, forbidden-field detection BEFORE parse, `member_self_update_forbidden` audit on forgery, member+contact patch with phone E.164 validation. Exported `SELF_UPDATE_CONTACT_SCHEMA_KEYS` / `SELF_UPDATE_MEMBER_SCHEMA_KEYS` for T116 parity test. 2026-04-16
- [X] T119 [P] [US5] Implement `application/use-cases/invite-colleague.ts` — primary-contact-only gating via `contactRepo.findById` + `isPrimary` check, wraps F1 `CreateUserPort`, creates secondary contact + links user. 2026-04-16
- [X] T120 [US5] API route `src/app/api/portal/profile/route.ts` (GET + PATCH) — `requireMemberContext` helper resolves session → member via `findByLinkedUserId` + finds caller's own contact. GET returns serialised member + contacts (notes redacted per contract #12). PATCH delegates to `memberSelfUpdate` with 403/400/404/500 error mapping. 2026-04-16
- [X] T121 [US5] API route `src/app/api/portal/contacts/invite/route.ts` — wraps `inviteColleague` use case, F1 `createUser` adapted via `CreateUserPort` wrapper, 201 returns contact_id + user_id. 2026-04-16
- [X] T122 [US5] Portal layout `src/app/(member)/portal/layout.tsx` — F1 layout retained (no changes needed), nav config extended with Profile link. 2026-04-16
- [X] T123 [US5] Profile view `src/app/(member)/portal/profile/page.tsx` — 3 real surfaces: company info (dl grid), plan section, contacts list with primary badge + portal-linked badge. Invite Colleague link visible only to primary contact (FR-015). FR-042: notes, override reasons, admin-only fields hidden entirely. `generateMetadata` for FR-037. 2026-04-16
- [X] T124 [US5] Edit form `src/app/(member)/portal/edit/page.tsx` + `src/components/members/portal-edit-form.tsx` — RHF+zod, 6 whitelisted fields only (firstName, lastName, phone, preferredLanguage, website, description). Diff-based PATCH (only changed fields sent). Sonner toast feedback. FR-042: no forbidden fields in DOM. 2026-04-16
- [X] T125 [US5] Invite form `src/app/(member)/portal/contacts/invite/page.tsx` + `src/components/members/invite-colleague-form.tsx` — primary-contact gate at page level, 5 fields (first_name, last_name, email, role_title, preferred_language). Sonner toast + redirect on success. 2026-04-16
- [X] T126 [US5] i18n `portal.profile.*` (19 keys), `portal.edit.*` (14 keys), `portal.invite.*` (14 keys), `nav.member.profile` across EN/TH/SV = 70 keys × 3 locales. `pnpm check:i18n` 667 keys parity green. 2026-04-16

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
