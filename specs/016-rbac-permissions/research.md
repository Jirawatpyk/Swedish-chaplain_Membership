# Phase 0 Research — 016 RBAC Permissions

**Status**: No open `NEEDS CLARIFICATION`. Every unknown raised during intake was resolved
in the brainstorming session (maintainer decisions) or by the three adversarial design-review
rounds (154 + 24 + 48 findings — `docs/superpowers/specs/2026-08-10-rbac-design-review-findings.md`).
This file consolidates the load-bearing resolutions in Decision / Rationale / Alternatives
form and pins the repo facts the design depends on. Design references (`D#`, `§ N`) point at
`docs/superpowers/specs/2026-08-10-rbac-permission-system-design.md` (v2 rev 3).

## R1 — Architecture depth: code-defined bundles (Phase 1), not DB-driven

- **Decision**: Permission catalogue + `ROLE_BUNDLES` as pure data in
  `src/modules/auth/domain/permissions/`. No new tables, no `/admin/roles` editor.
  Bundle changes = code change + deploy. Phase 2 (DB store + editor + custom roles)
  parked with explicit re-open triggers (design § 13).
- **Rationale**: The maintainer originally chose DB-driven + editor; the 154-finding
  round showed (a) no business driver requires runtime-editable bundles (TSCC bundle
  changes are rare, code-deploy cadence suffices), (b) 3 of the 5 critical defect
  classes (seed drift, Reset-to-default privilege grants, session-path RLS-bypassing
  JOIN) exist ONLY in the DB variant, (c) Phase 1's keys/evaluator/call-site work
  carries over unchanged if Phase 2 ever activates. Maintainer approved the descope
  2026-08-10.
- **Alternatives**: DB-driven now (rejected: unique critical classes, no driver);
  hardcoded role checks extended to 5 roles without a catalogue (rejected: keeps the
  deny-list fail-open pattern that motivated the feature).

## R2 — Cutover mechanism: `FEATURE_RBAC_V2` flag + per-call-site-class shim

- **Decision**: One evaluator with two legs, flag passed as an explicit parameter
  (pure Domain). Flag OFF reproduces observed pre-cutover behaviour via a shim table
  whose rows are **per call-site class, not per key**; flag ON evaluates the § 4.1
  matrix. Env reads live only in `src/lib/rbac.ts`. Expected legacy-leg cells are
  captured from OBSERVED behaviour, never derived from the shim (anti-circularity).
- **Rationale**: ~175 authorization sites over live money cannot cut over without a
  kill switch; rounds 2–3 each caught a shim-grammar error (manager fail-open on
  admin-gated routes; `legacySessionOnly` over-applied) that only observed-behaviour
  characterization exposes. Per-class rows kill the ambiguity: `legacySessionOnly`
  applies ONLY to the 17 genuinely ungated pages; every API row maps to its real
  current guard; `settings.invoicing` spans three rows; F6 families get `legacyF6Guard`.
- **Alternatives**: direct cutover (rejected: unreviewable, unrollbackable);
  per-key shim rows (rejected: round-3 Critical — one key spans differently-guarded
  call sites, a single row either widens or narrows one of them).

## R3 — Promotion sequencing: operator-gated Migration C + D18 pre-mint

- **Decision**: Existing human admins (+ unconsumed, unexpired admin invitations)
  promote to `super_admin` via **Migration C**, a data-only migration merged in its
  own migration-only PR whose deploy performs the promotion — technically gated:
  `run-migrations.ts` (from PR 2) exits 1 pre-migrate if the promotion file is
  pending while `FEATURE_RBAC_V2 !== 'true'`. Before flag-ON verification the
  operator pre-mints the first `super_admin` via updated `seed-bootstrap-admin`
  (refuses iff a super_admin exists). After C, `vercel promote` has a floor at the
  PR-2 deployment. System actors (SYSTEM_ACTORS in `scripts/seed-system-actors.ts` —
  f5001 Stripe webhook, f5002 Resend webhook, f5003 auto-invoice cron) are excluded
  by predicate.
- **Rationale**: rev-1 bundled promotion with PR-2 deploy → every staff account
  narrows before anyone holds SA keys = total lockout (Critical G1). Decoupling
  alone left the SA-orphan window (flag ON, zero SA accounts) — closed by D18.
  Convention-only sequencing rejected by round-3 SEC-R3-01: the gate must fail the
  BUILD, not rely on operator memory.
- **Alternatives**: promote at PR-2 deploy (lockout); promote lazily on first
  sign-in (rejected: mixed-role window, un-testable invariant); manual SQL promotion
  (rejected: unaudited, bypasses journal + rehearsals).

## R4 — Legacy-leg totalisation for the two new roles (D16)

- **Decision**: On the flag-OFF leg, `super_admin` evaluates with admin semantics;
  `marketing` is **DENIED all staff surfaces** (no-match → 404/403).
- **Rationale**: mapping marketing→manager would GRANT marketing manager's
  money-read surface during any emergency flag-OFF after PR 4 (round-3 SEC-R3-03).
  Losing marketing availability during an emergency is the accepted cost
  (maintainer-confirmed ⚑ #4); runbook documents it.
- **Alternatives**: marketing→manager mapping (rejected: money-read leak);
  blocking flag-OFF once marketing accounts exist (rejected: removes the
  emergency lever exactly when needed).

## R5 — Denial convention (D9)

- **Decision**: Pages → `notFound()` 404 (non-disclosure); API routes → typed 403 —
  EXCEPT `/api/admin/events/**` + `/api/admin/integrations/eventcreate/**`, which
  keep `adminOnlyWriterGuard` behaviour verbatim (manager 403 + RFC 7807 + F6
  `role_violation_blocked` audit; member/unknown/no-session 404). Every denial also
  emits `permission_denied` with pinned payload `{actor_user_id, role (real),
  permission_key, route path without query, request_id}`, fail-open.
- **Rationale**: preserves both the existing non-disclosure convention and the F6
  audit taxonomy (contract-tested elsewhere); the pinned payload keeps tokens/query
  PII out of the audit log (Principle I log hygiene).
- **Alternatives**: uniform 403 everywhere (rejected: discloses existence of admin
  surfaces to members); replacing the F6 guard semantics (rejected: breaks F6's
  audited contract for zero benefit).

## R6 — Last-super-admin invariant across FOUR removal paths (D13)

- **Decision**: App layer: `countActiveSuperAdmins()` pre-flight in `change-role`,
  `disable-user`, AND `erase-user`. DB layer: `users_last_admin_guard()` rewritten
  (never dropped) to transitional UNION population (`role IN ('admin','super_admin')`)
  in Migration B, strict SA-only in PR 5 — preserving the three-part contract:
  ERRCODE 23514, literal `'last-admin-protection'` substring, 0004 return-row logic
  (RETURN OLD on DELETE / NEW otherwise).
- **Rationale**: erase-user has NO count pre-flight today and erasure is
  irreversible — with a strict-only DB guard, erasing the last super_admin while a
  plain admin exists would pass both layers deterministically (round-3 SEC-R3-02).
  The UNION transitional population keeps the guard truthful during the window when
  admin+SA together are the guarded class. Contract preservation keeps
  `isLastAdminTriggerError` (src/lib/db-errors.ts) and its 3 consumers working.
- **Alternatives**: strict DB guard immediately (rejected: guards an empty set
  before C — rev-1 Critical); dropping the trigger and trusting the app layer
  (rejected: Principle IX substitute check #4 requires DB-level defence).

## R7 — Marketing scope boundaries (D2, ⚑ #1/#2/#5)

- **Decision**: Broadcasts full RW incl. send; **self-approval permitted** (recorded
  ⚑ #5). Events RW EXCLUDING attendee-PII erasure and registration relink
  (`events.relink` = admin + SA, ⚑ #1). Members/contacts read-only, no
  `members.pii_sensitive`, no `directory.export` (stays manager+admin, ⚑ #2 —
  behaviour-preserving). Insights engagement-only; activity feed redacted.
- **Rationale**: relink moves member linkage + benefit quota that F6 event-fee
  invoices resolve buyers from — a money-adjacent mutation; export is a bulk-PII
  egress channel; self-approval matches the existing (no submitter≠approver)
  invariant. All three confirmed by maintainer 2026-08-10.
- **Alternatives**: each recorded as an explicit veto option in design § 15; none
  taken.

## R8 — Migration mechanics under this repo's runner

- **Decision**: Migration A/B enum DDL uses `ADD VALUE IF NOT EXISTS`;
  `REQUIRED_ENUM_VALUES` (scripts/lib/enum-migration-guard.ts) extended with the new
  role + audit values; journal `when` must exceed the current global applied max;
  Migration C contains no literal BEGIN/COMMIT; the roleEnum tuple in
  `src/modules/auth/infrastructure/db/schema.ts` widens in the SAME commit as
  Migration A.
- **Rationale**: the runner's autocommit enum pre-pass (scripts/run-migrations.ts:94-137)
  re-executes enum DDL from ALL migration files — bare ADD VALUE fails every
  subsequent deploy (round-3 R3-M1). The `when`-collision class makes `db:migrate`
  a silent no-op (memory: bump +100000ms, verify via information_schema). A literal
  COMMIT in C would split the promotion from the journal bookkeeping. Tuple/DB enum
  divergence breaks Drizzle typing silently.
- **Alternatives**: `drizzle-kit generate` (abandoned at 0018 — hand-written SQL is
  the repo law); separate tuple-widening commit (rejected: window where inserts of
  new values type-check but fail at runtime, or vice versa).

## R9 — Call-site inventory: four pattern classes + the nav/palette data surface

- **Decision**: The PR-2 sweep greps and converts: (1) ~175 raw role-string
  comparisons (~120 files); (2) 4 escalate-to-admin + 4 demote-direction ternaries;
  (3) ~12 `as 'admin' | 'manager'` casts; (4) exhaustive role if-chains with
  default-deny/`return []` arms (search-plans.ts filterByRole + palette registry —
  fall through to EMPTY for unknown roles). PLUS the nav DATA surface:
  `src/config/nav.ts` literal `roles: ['admin']` arrays (erasure-log,
  broadcasts-settings, eventcreate-integration) widened to include `'super_admin'`
  in PR 2, replaced by declarative `requiredPermission` in PR 4.
- **Rationale**: classes 2–3 silently ESCALATE unknown roles to admin (fail-open);
  class 4 silently EMPTIES surfaces for promoted super_admins (fail-closed but
  breaks the operator); the nav arrays are a third authorization surface that would
  strand the erasure-log entry post-promotion (round-3 CC-1). Audit emitters that
  coerce unknown roles (≥6 sites) widen their `actor_role` unions — denials must
  record the REAL role (FR-006).
- **Alternatives**: sweeping only comparisons (rejected: the ternary/cast classes
  are the actual escalation bugs); deferring nav to PR 4 (rejected: post-C the
  operator loses nav entries in the window).

## R10 — Testing strategy pins

- **Decision**: Characterization split: PR 1 = evaluator-level rows (both legs,
  D16 rows) as a flag-parameterised CI job (`FEATURE_RBAC_V2` NOT force-set in
  tests/setup.ts); PR 2 = full page/API matrix joins it. Role × endpoint matrix is
  table-driven with an expected-class column (`role-matrix | public | cron-bearer |
  webhook-signature | portal-member`) and per-target-role rows for the six users
  routes; an fs-walk exhaustiveness test fails on any unclassified route export
  (recognises `export async function METHOD`, `export const METHOD = <ident>`
  aliases like `GET = POST`, `export const METHOD = <call>`). Live-Neon rehearsals
  run transaction-wrapped with ROLLBACK on the shared dev branch, reading the real
  migration files; they reduce the guarded population in-tx, never by stubbing
  count helpers. Verified: no `'use server'` actions exist → pages + API routes are
  the complete authorization surface.
- **Rationale**: the matrix is the review artefact for the sweep; exhaustiveness
  closes the "route added later without a row" hole; expected-class beats an exempt
  list (an exempt list rots silently); in-tx rehearsal keeps the shared dev branch
  clean (memory: enum drift + suite flake on shared Neon).
- **Alternatives**: mocked-DB trigger tests (rejected: the 0004 return-row and
  ERRCODE contracts only fail against real Postgres — repo law: integration tests
  hit live Neon).

## R11 — E2E persona strategy post-promotion

- **Decision**: PR 3 re-provisions `E2E_ADMIN_*` as a FRESH plain admin (post-C the
  original is promoted); adds `E2E_SUPER_ADMIN_*` (used only by users/audit/erasure/
  settings suites) and, in PR 4, `E2E_MARKETING_*`. Personas seeded via the existing
  global-setup seed idiom; dev-branch Migration C is coordinated with the PR-3 E2E
  changes (runbook step).
- **Rationale**: without re-provisioning, every "admin" E2E suite silently becomes a
  super_admin session that bypasses the evaluator — vacuous coverage of the narrowed
  admin bundle (round-3 finding).
- **Alternatives**: demoting the promoted persona back to admin in prod-mirroring
  environments (rejected: fights Migration C on every dev-branch reset).

## Verified repo facts the plan depends on (pinned during reviews)

| Fact | Where verified |
|---|---|
| 47 staff pages = 17 pure session-only (`legacySessionOnly` membership, pinned in contracts/authorization-surfaces §1.1) + 8 inert `admin\|\|manager` deny-arms (A\*) + 21 admin-only-checked + 1 redirect | full code walk 2026-08-10 (supersedes round-1's "47/11" note) |
| `users_last_admin_protection` trigger: migrations 0003/0004, reads OLD/NEW role, no WHEN clause | round-3 § 15 clean-checks |
| `isLastAdminTriggerError` at `src/lib/db-errors.ts:50-65`; consumers change-role.ts:94, disable-user.ts:96, erase-user.ts:154 (erase = catch-only, NO pre-flight) | round-3 SEC-R3-02 |
| `countActiveAdmins()` callers today = change-role.ts:80, disable-user.ts:83 | round-2 verification |
| Six mutating users API routes: invite, resend, revoke, change-role, disable, enable | round-2 verification |
| `invitations.consumed_at` / `expires_at` exist (schema.ts:816-817); roleEnum shared by `users.role` + `invitations.intended_role` | round-2 verification |
| Runner autocommit enum pre-pass at scripts/run-migrations.ts:94-137 re-executes ALL enum DDL | round-3 R3-M1 |
| Nav `roles: ['admin']` literals at src/config/nav.ts:301/349/376 | round-3 CC-1 |
| Palette fall-through-to-empty at search-plans.ts:396-403 + registry.ts:129-136 | round-3 CC-1 |
| `AuditViewerRole = 'admin' \| 'manager'` in src/modules/insights/application/audit-redaction.ts | round-2 verification |
| F9 dashboard = single ~460-line server component over one cached snapshot | round-1 fact-check |
| No `'use server'` actions in the codebase | round-3 clean-check |
| SYSTEM_ACTORS = 3 rows (f5001, f5002, f5003) in scripts/seed-system-actors.ts | round-3 CC-3 |
| `users_role_status_idx` suffices — no new indexes needed | round-3 clean-check |
