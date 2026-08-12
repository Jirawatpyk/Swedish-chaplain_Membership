# Tasks: RBAC Permissions — Super Admin + Marketing + Permission Bundles (Phase 1)

**Input**: Design documents from `/specs/016-rbac-permissions/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md) + design companion `docs/superpowers/specs/2026-08-10-rbac-permission-system-design.md` (v2 rev 3)
**Tests**: MANDATORY (Constitution II — TDD). Test tasks precede implementation for every unit; expected flag-OFF values come from OBSERVED behaviour (anti-circularity).

**Organization**: Phases map user stories onto the design § 9 delivery plan. **Delivery mapping**: Phase 2 = PR 1 (dark) · Phase 3/US2 = PR 2 (flag-gated cutover) · Phase 4/US1 = D18 + Migration C + PR 3 · Phase 5/US3 + Phase 6/US4 = PR 4 (ship together) · Phase 7 = PR 5. **US2 ships before US1's cutover on purpose** — spec §US2 "Why this priority": the positive gates must be complete before any new-role account exists. Every PR: full gates, solo-maintainer substitute review stack (plan Complexity #2), `enterprise-ux-designer` pass on UI PRs (PR 3/PR 4).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 from spec.md (user-story phases only)

---

## Phase 1: Setup

**Purpose**: Scaffolding that everything else builds on. (No new deps, no structural init — the repo exists.)

- [x] T001 Add 5 role display-name i18n keys to `shell.roleBadge` + `invitation-email` `ROLE_LABELS` across `en/th/sv`; `check:i18n` GREEN (5127 keys parity)
- [x] T002 DEFERRED to PR 2: the flag-parameterised CI env-matrix only becomes meaningful once `src/lib/rbac.ts` reads `FEATURE_RBAC_V2` (PR 2). In PR 1 the evaluator takes the flag as a pure parameter, so `tests/contract/rbac/evaluator-characterization.test.ts` already exercises BOTH legs in the existing unit job — an env matrix would run identical tests twice. DONE in PR 2: `rbac-flag-matrix` job in `quality-gates.yml` runs `tests/contract/rbac/` under real env `FEATURE_RBAC_V2=false|true` (locally verified: 337/337 on both legs)

---

## Phase 2: Foundational — PR 1 "Domain, dark" (BLOCKS all user stories)

**Purpose**: Pure Domain permission model + Role ×5 + Migration A. Zero prod behaviour change (nothing consumes the evaluator yet).

### Tests first (write → RED → commit)

- [x] T003 [P] Domain test: catalogue key format, flags, 40-key § 4.1 parity — `tests/unit/auth/permissions/permission-catalogue.test.ts` (+ pinned fixture `tests/helpers/rbac-pinned-matrix.ts`)
- [x] T004 [P] Domain test: `ROLE_BUNDLES` parity + invariants (no SA key in any bundle; `member` empty; landing invariant) — `role-bundles.test.ts` (also pins ROLES ×5)
- [x] T005 [P] Domain test: evaluator E1–E6 (SA bypass; SA-key refusal even in a poisoned bundle; matrix parity; D16; deterministic; unknown role → false) — `evaluator.test.ts`
- [x] T006 [P] Contract test: evaluator characterization BOTH legs + anti-circularity anchor (legacy leg ≡ observed `canAccess` after D16 normalisation) — `tests/contract/rbac/evaluator-characterization.test.ts`

### Implementation

- [x] T007 Widen `ROLES` (+ `ASSIGNABLE_ROLES` for staged assignability) + `STAFF_ROLES` + `PORTAL_FOR_ROLE` in `src/modules/auth/domain/role.ts`; barrel re-exports `ASSIGNABLE_ROLES`
- [x] T008 [P] `permission-catalogue.ts` — 40 pinned keys + flags; `PermissionKey` literal union via `CATALOGUE_RAW`; `SUPER_ADMIN_ONLY_KEYS` + `ALL_PERMISSION_KEYS`
- [x] T009 [P] `role-bundles.ts` — `ROLE_BUNDLES` (super_admin/admin = all non-SA keys; manager/marketing explicit; member empty)
- [x] T010 `evaluator.ts` (role-first signature; E1–E6; injectable bundles for the poisoned-bundle test) + `legacy-shim.ts` (D16 `normalizeLegacyRole` + `legacySessionOnly`/`legacyAdminOrManager`/`mappedLegacy` row primitives)
- [x] T011 Widen `roleEnum` tuple in `schema.ts` (same commit as T012)
- [x] T012 Migration A `0285_rbac_v2_role_enum.sql` (`ADD VALUE IF NOT EXISTS` ×2) + journal entry (`when` 1798541300000 > global max)
- [x] T013 `REQUIRED_ENUM_VALUES.role += ['super_admin','marketing']` in `enum-migration-guard.ts`
- [x] T014 Applied Migration A to dev Neon (`db:migrate` — NOTICEs confirm both labels present; `db:verify` 9/9 canaries) BEFORE commit; T003–T006 GREEN (269 tests). Plus: `Role`-widening ripple resolved across ~15 consumers (Record<Role> maps filled; metrics labels widened to `Role`; user-list-table imports Domain `Role`; actor-role stampings cast with `016 PR1` markers for PR-2 removal); pre-existing role tuple tests updated for FR-001; enum-guard fixtures updated. `typecheck` + `lint` clean.

**Checkpoint**: PR 1 mergeable — dark; evaluator proven at Domain level on both legs.

---

## Phase 3: User Story 2 — Every staff surface requires a positive permission (Priority: P1) 🎯 security core — PR 2

**Goal**: All ~175 role-string authorization sites (4 pattern classes) + nav/palette data converted to positive checks behind `FEATURE_RBAC_V2`; flag OFF byte-identical; denials audited; coverage mechanically enforced.

**Independent Test** (spec §US2): characterization passes on both legs; role × endpoint matrix passes; `check:staff-page-guard` + exhaustiveness test fail the build on an undeclared surface.

### Tests first (capture OBSERVED behaviour BEFORE any sweep edit)

- [x] T015 [P] [US2] Capture flag-OFF observed-behaviour cells for the full page/API matrix (pre-sweep snapshot, incl. manager DENIED on six users routes / both erasure endpoints / erasure log / invoice-settings mutations, and audit-viewer OFF-leg projection admin-full/manager-redacted) in `tests/contract/rbac/role-endpoint-matrix.test.ts`
- [x] T016 [P] [US2] API exhaustiveness fs-walk test (recognise `export async function METHOD` / `export const METHOD = <ident|call>`; expected-class column `role-matrix|public|cron-bearer|webhook-signature|portal-member`; fail on unclassified) in `tests/contract/rbac/api-route-exhaustiveness.test.ts`
- [x] T017 [P] [US2] Denial-audit contract test per role (pinned payload `{actor_user_id, role, permission_key, route_path-no-query, request_id}`; fail-open: emit-throw still serves denial; REAL role for unknown values) in `tests/contract/rbac/permission-denied-audit.test.ts`
- [x] T018 [P] [US2] Integration (live Neon, tx-wrapped ROLLBACK): transitional UNION trigger rehearsal — refuses demote/disable/delete/ERASE of last guarded row; plain `UPDATE`/non-last `DELETE` pass (0004 return-row); `isLastAdminTriggerError` matches ERRCODE+substring — in `tests/integration/auth/last-admin-guard-transitional.test.ts`
- [x] T019 [P] [US2] Integration: erase-user app-layer pre-flight refuses erasing the last super_admin while a plain admin exists (SC-003 erase path) in `tests/integration/auth/erase-last-super-admin.test.ts` — RED exposed a REAL defect: `countActiveAdministrators()` hardcoded the union, so the ON-leg erase of the last SA passed pre-flight (permanent lockout). Fix: population is now caller-supplied (`countActiveAdministrators(administrativeRoles(rbacV2))`) across erase-user + change-role + disable-user; repo `inArray` narrowing proven by a live-Neon relative-count case

### Implementation — infrastructure

- [x] T020 [US2] Add `FEATURE_RBAC_V2` (zod boolean, default false) to `src/lib/env.ts`
- [x] T021 [US2] Implement `src/lib/rbac.ts`: `requirePagePermission` (deny → emit → `notFound()`), `requireApiPermission` (deny → emit → typed 403), `canAccess` façade; `rbac.permission_denied_total{role, permission}` counter emission; the ONLY env-flag reads
- [x] T022 [US2] Complete `legacy-shim.ts` rows per call-site class: `legacySessionOnly` ONLY for the 17 pinned pages (contracts §1.1); `legacyAdminOrManager` for the 8 A\* inert-check pages; `mappedLegacy` per real guard (`users.manage`→`('auth:user','write')`, `members.erasure`→`('members','write')`); `settings.invoicing` ×3 rows; `legacyF6Guard`; fix the 4 stale guard comments pinned in contracts §1.1
- [x] T023 [US2] Author Migration B (audit enum `+= 'permission_denied'`; `CREATE OR REPLACE users_last_admin_guard()` UNION population preserving ERRCODE 23514 + `'last-admin-protection'` substring + 0004 return-row) + journal entry + `REQUIRED_ENUM_VALUES` `permission_denied`
- [x] T024 [US2] Register `permission_denied` in all 4 places (audit domain const, pgEnum, 2 test counts) — `src/modules/auth/**` audit taxonomy + `pnpm check:audit-events`/`check:audit-counts` green
- [x] T025 [US2] Apply Migration B to dev Neon; run T018 GREEN
- [x] T026 [US2] Rename `countActiveAdmins()` → `countActiveAdministrators()` (NOT `countActiveSuperAdmins` — during the transition it counts admin ∪ super_admin to mirror migration 0286; a super_admin-only name would describe behaviour it must not have until PR 5) ·  **the administrative population is FLAG-AWARE** (`administrativeRoles(rbacV2)`): union on the OFF leg so pre-cutover demotions still work, `super_admin` alone on the ON leg — counting plain admins there would let the last super_admin be erased while only plain admins remain, after which nobody holds `users.manage` and the tenant is permanently locked out (SC-003). App stricter than the DB trigger is safe; PR 5 (T069) narrows both and wire THREE callers — pre-flight added to `erase-user.ts` (new), kept in `change-role.ts` + `disable-user.ts` — in `src/modules/auth/application/`. **Re-key the existing last-admin pre-flight while you are there** (`change-role.ts`, currently `target.role === 'admin' && newRole !== 'admin'`): once PR 3 makes super_admin assignable, a single-admin tenant promoting its only admin → super_admin would be refused with `last-admin-protection` even though the promotion PRESERVES coverage. Guard on the elevated-staff set, not the `'admin'` literal (re-review 016 PR1, V-1 carry-forward — D13 does not name this)

### Implementation — the sweep (behaviour-preserving under flag; T015 cells are the referee)

- [x] T027 [US2] Gate every `(staff)` page with `requirePagePermission('<literal>', <shim row>)` — 46 pages swept + 1 redirect-only exemption; **11 pages denied by `redirect()` rather than `notFound()` pre-sweep, so the denial SHAPE changes from 302 to 404** (uniform page contract, outcome unchanged — recorded in the baseline); two erase pages had the guard inside a `try/catch` that would have swallowed `notFound()`'s control-flow throw and re-routed to sign-in — restructured; `/admin/members/[memberId]/benefits` C-2 carry-forward CLOSED (was throw→500 BELOW its PII reads, now 404 above them) incl. `/admin/users`, `/admin/audit`, all 4 settings pages + settings index, erasure log — `src/app/(staff)/admin/**`
- [x] T028 [US2] Gate every staff API route with `requireApiPermission` (except F6 families): six users routes branch per TARGET role (`users.manage` staff-target / `users.member_accounts` member-target) via the § 7.1 two-step wide→narrow gate (both OFF-leg rows = the pre-sweep `requireAdminContext` policy → byte-identical); erasure endpoints carry SA erasure keys — swept via baseline-driven codemod (92 files mechanical) + 8 ad-hoc guards by hand; renewals family composes the gate INSIDE `requireRenewalAdminContext(request, action, key)` so the F8 envelope + `f8_role_violation_blocked` contract survive; 2 F6 events GETs use `canPerform` keeping the FR-035 404 shape (D9). **Capture correction**: `GET /api/internal/exports/[jobId]/download` reclassified role-matrix→`session-any` — the original row misread the `role==='member'` actor-resolution branch as a deny-arm; gating it would 403 the portal's own GDPR-archive redirect (row removed + documented in the baseline header; SESSION_ANY now 5). 73 stale contract-test mocks retargeted admin-context→rbac; 2 ad-hoc route tests rewritten against the real evaluator; `ApiPermissionContext.sourceIp` tightened to `string` (drop-in parity with `AdminContext`)
- [x] T029 [US2] F6 families keep `adminOnlyWriterGuard` (legacyF6Guard rows from observed behaviour) — BOTH guards now take the route's `permissionKey` and decide ADMISSION via `canPerform(role, key, legacyF6Guard)` (OFF leg: admin ∪ super_admin per D16 — closes cutover defect 1 where a promoted super_admin 404ed on all 16 EventCreate routes; ON leg: the key decides, so PR 4 grants marketing `events.write` without touching the guards). Denial SHAPES stay D9 verbatim (manager 403+RFC7807+audit / member 404+audit / other 404+warn); 15 call sites keyed; stale admin-only header comment fixed in `[eventId]/archive/route.ts` (the actual archive route — the task's `[rid]/archive` path never existed); unit test gained super_admin-allow + marketing-deny cells (RED-first)
- [x] T030 [US2] Sweep escalate/demote ternaries (×8) + `as 'admin' | 'manager'` casts (~12) across `src/**` → evaluator-derived values (unknown role never escalates) — all `016 PR1` cast markers removed; sinks widened to literal `Role` (11 insights aliases, 8 invoicing viewer types, payments bridge, members timeline/halt, F6 ActorType, F8 RenewalActorRole); decision ternaries → literal role + explicit allow-guards (outreach, cycle-detail route+page, credit-notes/resend staff-arm narrows); presentation affordances evaluator-derived (`canMutate` via canPerform renewals.write; plans-table isAdmin via administrator set). REAL super_admin-breaking allow-list literals fixed: export-members-backup, download-export authorize, set-directory-logo, plans-table CTAs, renewals canMutate. Cutover defect 2 (staff-active picker + reassign query `role IN (admin,manager)`) → STAFF query widened separately below
- [x] T031 **(RESIDUAL CLOSED in PR 3 — see note)** [US2] Sweep default-deny if-chains: `search-plans.ts` filterByRole + command-palette registry (client mirror) — both route the role through the D16 totaliser (`normalizeLegacyRole` via the established pure-Domain deep-import idiom; no new ESLint carve-out needed — the deep path was already legal, see search-plans' pre-existing rationale): super_admin → admin (non-empty palette post-C), marketing/unknown → empty set
- [x] T032 [US2] Nav/palette data sweep (behaviour-preserving): `filterNavConfig` matches through the D16 totaliser as well as the literal arrays; the three `roles: ['admin']` arrays (erasure-log, broadcasts-settings, eventcreate-integration) widened to `['admin','super_admin']`; palette non-empty for super_admin (T031's totaliser); nav-config unit pin updated for the intentional widening
- [x] T033 [US2] Audit-emitter sweep: widened F6 `ActorType` + `role_violation_blocked` payload + both Emit*RoleViolationInput to literal `Role` (guards now emit attributable audits for EVERY known denied role incl. marketing, warn-log for unknown strings); F8 `RenewalActorRole` + `f8_role_violation_blocked.attempted_role` + `at_risk_outreach_recorded.actor_role` widened; renewals zod gates (`load-cycle-detail`, `record-at-risk-outreach`) admit super_admin; insights `dashboard_viewed.actor_role` + `recordStaffTimelineView` widened; all emitters record the LITERAL role (12+ sites — recordStaffBenefitView + EscalationTaskQueue were done in the T027 commit)
- [x] T034 [US2] ON-leg redaction re-keys: audit viewer/export use closed allow-list {admin, manager, super_admin} then PROJECT onto `AuditViewerRole` (NOT widened) — manager keeps today's redacted projection, admin AND super_admin (D16) get full (the old fall-through silently demoted a promoted super_admin to the manager view); ON-leg access itself is the `audit.read` page/route gate (D4 SA-only). Activity feed redacts for every role outside the administrator set — the population equals the `insights.activity_unredacted` holders, so PR 4's key-based restatement (T058) changes no behaviour
- [x] T035 [US2] Move DoB-class fields behind `members.pii_sensitive` (ON leg) in members read paths — the single staff READ egress is `GET /api/members/[memberId]?include=date_of_birth` (serialiseContact opt-in): now additionally requires `canPerform(role, 'members.pii_sensitive', legacySessionOnly)` — OFF leg admits every staff role (byte-identical), ON leg strips DoB from any bundle lacking the key (marketing, PR 4/T057). Edit/create forms are members.write surfaces (holders always carry pii_sensitive) and portal self-view is the subject's own data — both correctly ungated

### Implementation — gates, scripts, runbook

- [x] T036 [US2] Add D7 promotion-gate assertion to `scripts/run-migrations.ts` (pending promotion file + flag ≠ 'true' → exit 1 pre-migrate) — Phase 0 gate; pure decision logic in `scripts/lib/rbac-promotion-gate.ts` (naming contract `rbac_v2_promotion`, 7 unit tests TDD-red-first); verified END-TO-END on dev Neon: staged a harmless fake pending promotion + journal entry → `db:migrate` refused exit 1 BEFORE any DDL; restored → exit 0
- [x] T037 [US2] Create `scripts/check-staff-page-guard.ts` (clone portal-guard-core precedent; literal-only args) + `package.json` script + wire `.husky/pre-push` + `quality-gates.yml` static step
- [x] T038 [US2] Update `scripts/seed-bootstrap-admin.ts` (mints `super_admin`; refuses IFF a super_admin exists — D18 contract; plain admins never block the pre-mint) + DR/dev scripts widened to the administrator union (`verify-admin.ts`, `seed-partial-broadcast.ts`)
- [x] T039 [US2] Coverage config: explicit 100%-branch entry for `src/lib/rbac.ts` in `vitest.config.ts`; absence from the coverage-exclude list is asserted mechanically by `tests/unit/architecture/rbac-coverage-config.test.ts` (text-level, catches the rbac-guard.ts exclusion fate)
- [x] T040 [US2] Author `docs/runbooks/rbac-v2-cutover.md`: pre-mint → flag flip + verification checklist (abort criterion = any unexpected denial pair) → Migration C procedure (gate + **re-validate C's journal `when` > global applied max AT MERGE TIME** — other features may land migrations between authoring and merge; silent-no-op class — + information_schema trigger check) → promotion floor → per-window rollback incl. marketing-availability note → interrupted-session recovery (CHK085) → PR-4 env verify → PR-5 env delete → bundle-change procedure → READ_ONLY_MODE — all 10 sections + cutover-log template; D7 naming contract (`rbac_v2_promotion`) cross-referenced with T036
- [x] T041 [US2] Full matrix GREEN both legs (T015 ON-leg cells now from § 4.1, **incl. per-target-role rows for the six users routes** — new matrix block pins users.manage SA-only / users.member_accounts SA+admin on the ON leg + the shared OFF-leg row); FULL unit+contract suite **1,181 files / 13,061 tests GREEN** (the run flushed 3 stale-mock stragglers first: schedules arg-asserts, webhook-base-url env mock, export-download barrel-drag → deep Domain imports); `pnpm lint` + `check:i18n`/`layout`/`fixme`/`dates`/`env-example`/`env-boot`/`staff-page-guard`/`audit-events`/`audit-counts`/`template-seed`/`portal-guard` all OK; `pnpm typecheck` LAST — clean

**Checkpoint**: PR 2 mergeable — flag OFF byte-identical (SC-002 evidence banked); flag ON = new matrix + D4 narrowing. US2 independently testable.

---

## Phase 4: User Story 1 — Super Admin controls staff access; admin safely scoped (Priority: P1) — D18 + Migration C + PR 3

**Goal**: Promotion cutover with zero lockout; `/admin/users` retrofit; E2E personas that keep exercising the evaluator.

**Independent Test** (spec §US1): seeded env, flag ON + promotion applied: super_admin invites/changes role/opens audit; demoted admin 404s on users/audit/settings.invoicing/erasure-log while money ops still succeed.

### Tests first

- [x] T042 [P] [US1] Integration (live Neon, tx-wrapped): Migration C promotion rehearsal reading the real SQL file — every pre-C human admin promoted; **all three** system actors untouched; D18 pre-minted row untouched; open admin invitations promoted; expired skipped; (user, invitation) coherence — in `tests/integration/auth/migration-c-promotion.test.ts`. **DONE** — TDD RED (ENOENT on the staged SQL) → authored T047 → GREEN 5/5. Reads the real file from `drizzle/migrations/pending/0287_rbac_v2_promotion.sql`; asserts active+disabled human admins → super_admin, f5001-3 untouched (role=admin/disabled), D18 super_admin untouched, open invite coherent (user+invitation both super_admin), expired invite skipped (intended_role stays admin)
- [x] T043 [P] [US1] Integration: reversed-order C-before-B rehearsal asserts ABORT under the old 0004 guard in `tests/integration/auth/migration-order-abort.test.ts`. **DONE** — GREEN 2/2: restores the verbatim 0004 admin-only guard in-tx → applying the REAL Migration C on the last admin aborts (23514 + `last-admin-protection`, via `isLastAdminTriggerError`); positive control proves the identical promotion SUCCEEDS under the ambient 0286 union guard (rules out an always-throw). DDL restore + all writes rolled back
- [x] T044 [P] [US1] Contract: redeem-invite tamper check stays coherent across promotion (promoted user + promoted invitation) in `tests/contract/rbac/invitation-promotion.test.ts`. **DONE** — GREEN 4/4: drives the REAL `redeemInvite` (fakes for repos/infra only) across the three pairings C could leave — coherent super_admin×super_admin REDEEMS; user-only (super_admin×admin) and invitation-only (admin×super_admin) each fail the `user.role === invitation.intendedRole` tamper check (link-invalid); control admin×admin redeems (rules out always-fail). Documents WHY C's second UPDATE (invitations) is required
- [x] **T031-R (PR 3 residual, found while verifying the T045/T046 selectors)** — the palette has **TWO** client-side role filters and T031 only fixed one. `src/components/command-palette/registry.ts → filterEntriesByRole` (static registries) was routed through the D16 totaliser; the SECOND filter — applied to the search RESPONSE, living inline in `command-palette.tsx` as `currentUserRole === 'admin' ? … : {…}` — was never touched, and `command-palette-root.tsx` passes the RAW role. Post-Migration-C every promoted human fell through it and received `actions: []` + `refundableInvoices: []`: the entire Actions group (New plan/member/invoice, Record payment, Issue refund, Review broadcasts, View audit log, …) silently vanished from the palette for every operator while the server correctly sent it. Third occurrence of the C1 affordance class, and exactly the [[reference-widening-a-domain-union-needs-shadow-sweep]] shape — a LOCAL COPY of a predicate the union sweep cannot see. **Fixed** by extracting `filterResultsByRole(results, role)` into `registry.ts` beside its sibling (normalised via `normalizeLegacyRole`; `navigate` now keyed on the normalised value so a future role cannot inherit it by merely not being `'member'`), wired into the component, `ADMIN_ONLY_ACTION_IDS` moved with it. 6 unit tests over all 5 roles + unknown; **mutation-proven** (restoring the raw `role === 'admin'` → the super_admin case fails `expected [] to have a length of 2`). The T046 palette E2E now asserts the "View audit log" option for a super_admin, so the fix is covered in a real browser too
- [x] T045 [P] [US1] E2E: plain-admin persona assertion list — 404 on `/admin/users`, `/admin/audit`, `/admin/settings/invoicing`, erasure log; erasure APIs denied; invoice issue + refund record + member edit succeed; **+ axe a11y scan on the retrofitted users page (PR-3 ships with a11y evidence, not deferred to PR 4)** — in `tests/e2e/rbac-admin-persona.spec.ts`. **AUTHORED (typecheck + lint clean); NOT YET EXECUTED** — an ON-leg suite: skips unless `E2E_RBAC_V2_ON=true` + fresh `E2E_ADMIN_*`, which only holds during the T051 coordinated session (server `FEATURE_RBAC_V2=true` + Migration C applied on dev + seed re-run). Asserts 404 on the 4 D4 surfaces, reachability of invoices/members/renewals, SA-only nav links absent, axe on a reachable admin surface. **Persona-mismatch correction**: the users-PAGE axe moved to T046 — a plain admin 404s on `/admin/users` and can never render it (a-plan-can-mandate-a-defect)
- [x] T046 [P] [US1] E2E: super_admin persona — invite staff (narrowed-admin bundle lands per US1-AS2), change role, open audit unredacted, non-empty palette, erasure-log nav entry present; **+ axe a11y scan of the users-page dialogs/picker** — in `tests/e2e/rbac-super-admin-persona.spec.ts`. **AUTHORED (typecheck + lint clean); NOT YET EXECUTED** (same ON-leg gate as T045). Asserts /admin/users renders, invite dialog offers Super Admin, change-role picker opens with exactly super_admin/admin/manager radios (member/marketing absent), /admin/audit reachable, erasure-log nav present, command palette non-empty; axe scans the users page + open change-role picker + open invite dialog (the users-page a11y evidence T045 could not carry)

### Implementation

- [x] T047 [US1] Author Migration C SQL (promotion UPDATEs ×2 with SYSTEM_ACTORS ids enumerated from `scripts/seed-system-actors.ts`; no literal BEGIN/COMMIT) + journal entry — **in its own migration-only PR branch; NEVER merged to main until the operator step (D7)**; rehearse on dev via T042. **DONE** — authored at `drizzle/migrations/pending/0287_rbac_v2_promotion.sql` (NOT top-level: the D7 gate's `readdirSync` is non-recursive+`.sql`-filtered, so `pending/` is invisible to the gate/enum-pre-pass/migrator, keeping this branch's `db:migrate` + Vercel preview build GREEN while the rehearsals read the real file). No BEGIN/COMMIT; f5001-3 excluded by id; open-invite second UPDATE; header carries the operator `git mv`→top-level + journal (`when` > 1798541400000, re-validate at merge) step (T052). Journal entry itself is deliberately NOT added on this branch (would trip D7 for everyone). Rehearsed GREEN via T042/T043
- [x] T048 [US1] Users page retrofit: role picker (super_admin/admin/manager — marketing hidden until PR 4), member-account lifecycle preserved, denied-state presentation for plain admin (CHK051), last-SA refusal error message via i18n keys ×3 locales (CHK052) — `src/app/(staff)/admin/users/**`. **IMPL GREEN + enterprise-ux review FOLDED.** Review verdict "ship with follow-ups": **C1 (Critical — CHK050 FAIL) FIXED** — the picker was mounted conditionally (`{roleChangeUser ? … : null}`), so closing it unmounted the Base UI Root in the same frame and `finalFocus` never fired (focus → `<body>`); now mounted UNCONDITIONALLY driven by `roleDialogOpen`, user retained through the close (like the sibling ConfirmationDialog). **I1 FIXED** (dropped `initialFocus` off Cancel — a picker, not a destructive confirm; Base UI lands focus in the RadioGroup). **I2 FIXED** (TH/SV last-admin error now uses the localized "ผู้ดูแลระบบสูงสุด"/"Superadministratör", matching the picker term). **S3 FIXED** (change-role trigger gated on `CHANGE_ROLE_OPTIONS.includes(role)` so a marketing row can't open a picker missing its own Current badge). S6 auto-resolved by C1. Deferred to follow-up: S1 (AlertDialog-vs-Dialog — deliberate no-backdrop-dismiss), S2 (super_admin promotion caution copy), S4 (unreachable defensive error codes), S5 (≤md 3-button row density). Reviewer CONFIRMED: accessible-name via `aria-labelledby`, target size (hit-area ≥40px), focus-visible/keyboard, i18n parity+no-italic-TH, CHK049/052/056. New `ChangeRoleDialog` (AlertDialog + RadioGroup, super_admin/admin/manager; member/marketing excluded) POSTing `/api/auth/users/[id]/role`, last-admin-protection/same-role/role-portal-mismatch surfaced as localized inline `role=alert` (CHK052), confirm disabled until changed. **Killed the C1-affordance literal** `isAdmin = role==='admin'` in `user-list-table.tsx` → server-computed `canManageAccounts`/`canManageStaffRoles` booleans threaded from `page.tsx` via `canPerform` (would have flipped the whole page read-only for every human post-Migration-C). Change-role trigger on staff rows only, non-self. Per lockstep (design "widen all three together"): `ASSIGNABLE_ROLES`+=super_admin, invite route + change-role route zod +=super_admin, `invite.roles.super_admin` + `changeRole.*` i18n ×3 (no italic on TH); invite step-2 `users.manage` gate already keeps SA-mint SA-only. CHK051 = page is `users.manage` SA-only (admin 404s, no partial view — unchanged). Tests: user-list-table 24/24, change-role-dialog 5/5 (incl. last-admin inline error + POST payload, PointerEvent-polyfilled radio drive), change-role contract 14/14 (super_admin-accepted pin), lockstep + role domain pins updated. typecheck/lint/i18n(5143)/api-route-guard(119)/staff-page-guard(47) clean
- [x] T049 [US1] Explicit `finalFocus` on every users-page dialog incl. fixing the pre-existing `user-list-table.tsx` omission; keyboard E2E asserts `document.activeElement !== body` after each row action. **IMPL GREEN** — the disable/enable/revoke `ConfirmationDialog` (which had NO finalFocus — its per-row trigger unmounts under the success `router.refresh()`, dropping focus to `<body>`) and the new `ChangeRoleDialog` both now pass `finalFocus={dialogFinalFocus}` targeting the surviving `#main-content` landmark (staff layout's focusable `<main>`). Reuses the ConfirmationDialog's existing optional `finalFocus` prop. Keyboard `activeElement !== body` assertion lands in the T045/T046 E2E specs (jsdom AlertDialog focus-return is not a reliable seam)
- [x] T050 [US1] Re-provision E2E personas: fresh plain-admin `E2E_ADMIN_*` + new `E2E_SUPER_ADMIN_*` (users/audit/erasure/settings suites only) via the global-setup seed idiom in `tests/support/**`; document in `.env.local` template + quickstart. **CODE + DOCS DONE (typecheck + lint clean); SEEDING runs at T051.** `scripts/seed-e2e-user.ts` now mints `E2E_SUPER_ADMIN_*` (role=super_admin, upserted FIRST so the admin row can be demoted back to plain admin post-Migration-C without tripping the last-admin trigger) and its idempotent admin upsert IS the "fresh plain admin" reset. `signInAsSuperAdmin` added to `helpers/admin-session.ts` (refactored to share `signInStaff`). Quickstart documents the run-seed-AFTER-Migration-C ordering + `E2E_RBAC_V2_ON` opt-in. (`tests/support/**` global-setup wiring is a `playwright.config` concern deferred to the operator run — the persona sign-in is the used seam.) `.env.example` intentionally NOT touched (E2E vars are not env.ts-validated → not in scope for check:env-example)
- [ ] T051 [US1] Apply dev-branch Migration C in coordination with T050 (runbook § dev-branch step); all US1 tests GREEN. **SKIPPED — NOT DONE.** The production cutover (T052) ran first and its live verification walk superseded the de-risking purpose of a dev rehearsal. Two consequences stand and must not be quietly forgotten: (1) **the T045/T046 persona E2E suites have never executed anywhere** — they are authored, typecheck/lint clean, and unproven; (2) five pre-existing E2E specs (`admin-erasure-log`, `f9-audit`, `invoices/invoice-settings`, `admin-journey`, `breadcrumb-navigation`) still sign in as `admin` and open D4-narrowed surfaces, so on the ON leg their assertions are false. **If Migration C is ever applied to the dev branch, re-run `scripts/seed-e2e-user.ts` in the same breath** — otherwise the promoted `e2e-admin` silently becomes a super_admin session and turns those five suites GREEN while proving nothing (design § 9 PR 3 warns about exactly this). `FEATURE_RBAC_V2=true` is now set in `.env.local`, so the D7 gate no longer blocks `pnpm db:migrate` on dev. Folded into PR 4's persona work (T059/T062)
- [x] T052 [US1] **OPERATOR (user-gated)**: production cutover session per runbook — pre-mint via `pnpm db:seed-admin` → flip `FEATURE_RBAC_V2=true` + redeploy → verification checklist with expected-denial baseline → merge/deploy Migration C PR → post-C assertions (promotion counts, system actors, coherence). **✅ EXECUTED 2026-08-11 — full log in `docs/runbooks/rbac-v2-cutover.md` § 9.** PR #323 (dark) `df3f25908` → pre-mint `beb20aff-…` → flag ON → walk PASS (plain admin denied exactly the 4 D4 surfaces; money/member untouched; denial trail = 4 pairs, all declared, zero unexpected → no abort) → PR #324 `3319a03b1` → promotion PROVED via `__drizzle_migrations` (not the runner's success line) → post-C: 0 human plain-admins, 3 system actors untouched, 0 incoherent invitations → live re-verification: the promoted admin signs in as `super_admin` and reaches all four. Final: 3 super_admin active, 3 admin/disabled (system actors). **Unplanned finding:** journaling Migration C made CI's required `Integration smoke` fail permanently (`ci-neon-env` seeds `.env.local` from `.env.example` where the flag is `false`, and a disposable Neon branch never gets the prod flag) — fixed by scoping the flag to the `Apply migrations` step; remove with the gate in PR 5. **Prediction that was wrong:** the runbook said to expect a RED Vercel preview; it passed, because the env var is scoped to all environments. Runbook § 5 step 2 now describes both cases

### PR 3 review round 1 (`/speckit-review`, 7 dimensions × adversarial verification, 15 agents)

**Verdict: MERGE-AFTER-FIXES · Security: SIGN** (plan Complexity #2 — no privilege-escalation path into `super_admin` found on either leg by two independent dimensions; residual risk was entirely in the operator-gated Migration C choreography, which merging does not execute). 0 Critical (2 filed CRITICAL were REFUTED on verification: the "OFF leg not byte-identical" claim dies on D16 + FR-007 scope). 12 Important→SUGGESTION and 6 Suggestions dropped outright by the verify layer.

All 5 Important + 4 Suggestions CLOSED in `6b1e0a7`-era commit:

- **I-1 D7 gate bypassable (the one that mattered)** — `promotionGateFailure` derived the promotion set from the FILE listing only. Drizzle's `readMigrationFiles` resolves `${folder}/${tag}.sql` with **no path sanitisation**, so a journal entry tagged `pending/0287_rbac_v2_promotion` makes the migrator apply the promotion while the gate sees nothing and returns null — the flag-unset promotion FR-008/SC-006 call technically impossible. Verifier CONFIRMED it end-to-end ("could not break it"). Fixed: candidates are now the union of file-derived and **journal-derived** tags. Mutation-proven.
- **S-2 silent no-op (folded in)** — a promotion journaled with `when` ≤ applied max is SKIPPED while the runner prints "✓ applied"; `REQUIRED_ENUM_VALUES` is blind to a data-only migration. The gate now refuses it. Mutation-proven.
- **I-2 cutover docs described a mechanism that no longer exists** — runbook §1/§5 still said "merge the Migration C PR" + "re-validate C's journal `when`"; there is no PR and no journal entry. `quickstart.md:91` was outright false **and was edited by this PR without being reconciled**. An operator following the runbook literally would never apply C. Rewrote runbook §1 (staged-not-shipped + verification commands + the both-shapes gate note) and §5 step 1 (concrete `git mv` + add-journal-entry + renumber), plus both quickstart lines.
- **I-3 T045 asserted PR-4 behaviour** — `nav.ts` still filters on role literals; users/audit carry **no** `roles` key and erasure-log carries `['admin','super_admin']`, so a plain admin sees all three links and the three `toHaveCount(0)` were guaranteed red — inside a suite whose first run IS the cutover window. Verified against `nav.ts:281-312` before changing. Replaced with what PR 3 actually guarantees: the link is still rendered (nav unswept until T063) but the page gate makes it a dead end.
- **I-4 cross-row state leak in the privilege-change dialog** — **introduced by this PR's own C1 fix** (unconditional mount + retained user): open row A → pick Super Admin → close → open row B → `selected` still `'super_admin'`, Confirm **enabled and pre-armed**, one click promotes the wrong user. The guarding effect had ZERO coverage — deleting it left 6/6 green. Added 2 rerender tests; mutation-proven (deleting the effect kills exactly the 2 new ones).
- **I-5 abort rehearsal would COMMIT** — rollback was a side effect of the assertion; if C's predicate ever stopped aborting, postgres-js commits both the blanket `status='disabled'` update AND the revert of `users_last_admin_guard()` to its pre-016 body onto shared dev. Adopted the sibling's unconditional `ROLLBACK` sentinel.
- **S-1 system-actor drift (flagged by 5 of 7 dimensions)** — the exclusion list was hand-copied into the SQL and the fixture, so a 4th actor seeded before T052 would be silently promoted with every test green. Replaced with the repo's own reserved-namespace predicate (`id::text NOT LIKE '00000000-0000-0000-0000-0000000%'`, mirroring `RESERVED_SYSTEM_ACTOR_PREFIX`); `gen_random_uuid()` cannot produce that shape. New test seeds a FUTURE actor nobody enumerated — mutation-proven (the old id-list form lets it through).
- **S-4 rehearsals hardcoded `pending/`** → ENOENT after the T052 `git mv`; both now fall back to the shipped path. **S-6** the naive `;` splitter is now guarded by an assertion that the file contains no `$$` / literal `BEGIN;`/`COMMIT;`. **S-11** `user === null` folded into the Confirm gate.

Deferred with rationale: S-3 (window-B invitation demotion — needs the optional full-revert path), S-9/S-10 (in-flight response race + non-retryable error copy — real but no reachable data harm), S-12 (single capability map instead of two booleans), S-13 + the `ADMIN_ONLY_ACTION_IDS` 4-of-9 mirror (both pre-existing, outside this diff), S-8 (add T051 to T052's dependency list — do at cutover planning).

**Checkpoint**: US1 live — principal demotes day-to-day staff from the UI; SC-006 zero-lockout evidence recorded in the runbook.

---

## Phase 5: User Story 3 — Marketing runs E-Blast + events without money/PII (Priority: P2) — PR 4 (ships with Phase 6)

**Goal**: Marketing role assignable and safe: engagement-only insights, minimised member read, full broadcast/event flows.

**Independent Test** (spec §US3): marketing persona — full compose→approve→send; `/admin/invoices` 404 + invoice APIs 403; engagement-only dashboard with no dead links; relink denied.

### Tests first

- [x] T053 [P] [US3] Contract: marketing rows joined to the role × endpoint matrix — ALL money/PII/compliance surfaces denied (incl. `events.relink`, `directory.export`, settings, users, audit); broadcasts/events/members-read/insights-engagement allowed — in `tests/contract/rbac/role-endpoint-matrix.test.ts`
- [x] T054 [P] [US3] Unit: insights snapshot split — widget→permission map; finance data ABSENT from the engagement payload (server-side, not hidden) — in `tests/unit/insights/snapshot-split.test.ts`
- [ ] T055 [P] [US3] E2E: marketing persona walk — E-Blast full flow succeeds; event registrations + CSV import; 404 `/admin/invoices`; engagement dashboard no grid holes/dead links; member profile shows no DoB — in `tests/e2e/rbac-marketing-persona.spec.ts`

### Implementation

- [x] T056 [US3] Split the F9 snapshot loader into separately cacheable engagement/finance parts + widget→permission map in `src/modules/insights/**` + `src/app/(staff)/admin/page.tsx` (grid collapses gracefully)
- [x] T057 [US3] VERIFY `members.pii_sensitive` stripping holds for marketing on the SINGLE-MEMBER read (`GET /api/members/[memberId]?include=date_of_birth` — key-based gating from T035, no re-implementation) + marketing-specific UI paths only (profile render, directory row) in member read APIs + profile UI. **Corrected by 016 review I5** — the original wording claimed T035 was a chokepoint covering every DoB egress; it is not. DoB also leaves via `GET /api/admin/members/export.zip` (backup CSV, every contact in the tenant) and the GDPR member archive, both gated on `members.bulk` alone. Those are safe today only because `members.bulk` and `members.pii_sensitive` happen to have identical holders, which `tests/unit/auth/permissions/role-bundles.test.ts` now pins as an enforced subset invariant. So T057 = verify the single-member read AND confirm the invariant test still guards the two bulk paths; if PR 4 ever grants marketing `members.bulk`, gate those two paths on `members.pii_sensitive` explicitly instead of relying on the coincidence
- [x] T058 [US3] PII-redacted activity feed for non-`insights.activity_unredacted` holders (marketing) in insights feed components
- [x] T059 [US3] Role picker += `marketing` (PR-4 reveal) in users page; seed `E2E_MARKETING_*` persona via global-setup idiom
- [ ] T060 [US3] ROPA/privacy documentation update: staff-role-administration activity + marketing member-read scope + DPIA-trigger answer (CHK035) + last-SA-erase vs Art. 17 rationale (CHK041) in the privacy docs + `docs/runbooks/rbac-v2-cutover.md` cross-ref

**Checkpoint**: US3 independently testable end-to-end with the seeded marketing persona.

---

## Phase 6: User Story 4 — Navigation & palette reflect real permissions (Priority: P3) — PR 4 (ships with Phase 5)

**Goal**: Declarative `requiredPermission` everywhere; no role literals in nav code; flag default ON.

**Independent Test** (spec §US4): per-persona walk — sidebar/palette/settings-index visible set ≡ permitted set; every visible entry opens; `/admin` renders ≥1 widget for every staff role.

### Tests first

- [x] T061 [P] [US4] Unit: nav config declares `requiredPermission` per item; server-derived filtering; zero role literals (architecture-guard assertion) in `tests/unit/config/nav-permissions.test.ts`
- [ ] T062 [P] [US4] E2E: four-persona navigation walk (super_admin, admin, manager, marketing) — visible ≡ permitted, no dead links, landing invariant; **+ manager direct-URL assertions (404 on `/admin/users` + `/admin/audit`; all four settings pages denied — design §10 manager list)** — in `tests/e2e/rbac-navigation.spec.ts`

### Implementation

- [x] T063 [US4] Replace nav role arrays with declarative `requiredPermission` + server-side filtering in `src/config/nav.ts` + shell components
- [x] T064 [US4] Palette actions + settings index render from declared permissions in palette registry + `src/app/(staff)/admin/settings/page.tsx`
- [x] T065 [US4] Architecture guard: authorization role-reads outside the identity allowlist fail (nav/palette filters IN scope; **the F6 `adminOnlyWriterGuard` role reads are a PERMANENT allowlist entry — D9 route-local override survives PR 5**) in `tests/unit/architecture/rbac-authorization-reads.test.ts`
  - **Implemented as a SCRIPT gate** (`scripts/check-authorization-role-reads.ts`) wired into `package.json` + `.husky/pre-push` + `quality-gates.yml`, not `tests/unit/architecture/rbac-authorization-reads.test.ts` as originally scoped: it belongs with its siblings `check:staff-page-guard` / `check:api-route-guard`, runs in the fast static-gates job rather than the architecture-test job, and prints per-site remediation. Markers live AT each site, not in a central allowlist.
- [x] T066 [US4] Flip flag code-default → `true` in `src/lib/env.ts`; add PR-4 runbook step: verify prod env var unset or `'true'` (leftover `'false'` defeats the flip)
- [ ] T067 [US4] Observability completion: expected-denial baseline alert (extended for marketing) + `docs/observability.md` metric/SLO entries + a11y (`@a11y`) + i18n (`@i18n`) E2E sweeps green on PR-4-changed surfaces (nav, palette, settings index, dashboard split — users page already covered by T045/T046)

**Checkpoint**: PR 4 mergeable — marketing usable end-to-end; nav fully permission-aware; flag default ON.

---

## Phase 7: Polish & Cleanup — PR 5

**Purpose**: Delete the temporary complexity (plan Complexity #3) and finish the strict end state.

- [ ] T068 Delete legacy leg + `legacy-shim.ts` + `canAccess` façade + `policies.ts` + `FEATURE_RBAC_V2` env read; collapse evaluator to single leg; update evaluator/characterization tests to ON-leg-only; CI job drops the flag matrix
- [ ] T069 Author strict-trigger migration (`users_last_admin_guard()` SA-only population, same 3-part contract) + journal; apply to dev; re-run `tests/integration/auth/last-admin-guard-transitional.test.ts` updated to strict population
- [ ] T070 [P] Docs: `docs/runbooks/tenant-onboarding.md` note (roles code-defined, no per-tenant seeding); `docs/changelog.md` entry; CLAUDE.md § Recent Changes
- [ ] T071 **OPERATOR**: delete the `FEATURE_RBAC_V2` Vercel env var (runbook PR-5 step)
- [ ] T072 Final verification: SC-001–SC-007 walk-through per acceptance scenario (memory: verify each AS against spec); full gate run (`lint`, `test:coverage` — Domain 100% / rbac.ts 100% branch, `check:*`, `test:integration` auth files, `test:e2e --workers=1`, `typecheck` LAST)

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 → Phase 2**: T001–T002 anytime before PR 1 merge.
- **Phase 2 (PR 1) BLOCKS everything** — the evaluator + Migration A are the foundation.
- **Phase 3 (US2/PR 2) BLOCKS Phase 4** — positive gates must be complete before any new-role account exists (spec §US2 rationale). T015 (observed-behaviour capture) MUST precede T027–T035 (the sweep).
- **Phase 4 (US1)**: T047 (Migration C) merges ONLY at T052 (operator step). T052 gates production; dev-side tasks T042–T051 proceed without it.
- **Phase 5 + Phase 6 (PR 4)**: depend on Phase 4's cutover being live (marketing assignable only post-C); the two phases ship in one PR — sequence T053–T060 then T061–T067, or interleave (different files).
- **Phase 7 (PR 5)**: only after PR 4 has soaked in prod (runbook: ≥1 clean window with no unexpected denial pairs).

### Key task-level dependencies

- T010 ← T008, T009 · T014 ← T011–T013 · T021 ← T020 · T025 ← T023 · T026 ← T023 (trigger + guard rename land together) · T027–T035 ← T021, T022, T015 · T041 ← all of Phase 3 · T051 ← T047, T050 · T052 ← T036 (gate), T038 (pre-mint), T040 (runbook), T041 · T059 ← T048 · T066 ← T052 · T068 ← T066 soak · T069 ← T052 (strict only after promotion)

### Parallel opportunities

- Phase 2 tests T003–T006 all [P]; T008+T009 [P].
- Phase 3 tests T015–T019 all [P] (different files). Sweep tasks T027–T035 touch disjoint file sets — safe to sequence-batch, but this repo mandates file-mutating agents run SEQUENTIALLY (memory rule); [P] on tests only.
- Phase 4 tests T042–T046 all [P]. Phase 5 T053–T055 [P]. Phase 6 T061–T062 [P].

---

## Implementation Strategy

**MVP scope = Phases 1–4** (US2 + US1). US1 is the business driver but is unsafe without US2 — the two P1 stories deliver together across PR 1 → PR 2 → cutover → PR 3. STOP and validate after Phase 4: principal operates `/admin/users`, demotes staff, prod runs the new matrix. Phases 5–6 (PR 4) then activate marketing + declarative nav as one increment; Phase 7 removes the scaffolding.

**Rollback awareness per increment**: PR 1 dark · PR 2 flag OFF = true rollback · post-C flag OFF = degraded-safe + demotion (promotion floor on `vercel promote`) · PR 4 emergency env `'false'` (marketing loses access — accepted) · PR 5 irreversible only after soak.

---

## Notes

- Every migration task follows repo law: apply on dev + integration-test BEFORE committing (memory: migration-apply-before-commit); `when` collision = silent no-op — verify via information_schema.
- Never `git add -A`; never prettier; typecheck LAST after the final edit of each PR.
- T052 and T071 are OPERATOR tasks — user-gated, never executed autonomously.
