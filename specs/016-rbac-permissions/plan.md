# Implementation Plan: RBAC Permissions — Super Admin + Marketing + Permission Bundles (Phase 1)

**Branch**: `016-rbac-permissions` | **Date**: 2026-08-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-rbac-permissions/spec.md`
**Authoritative design companion**: `docs/superpowers/specs/2026-08-10-rbac-permission-system-design.md`
(v2 rev 3, commit `2bdb4f195`) — decisions D1–D18, pinned § 4.1 catalogue, § 5 migration SQL,
§ 6.1 shim grammar, § 6.2 flag lifecycle, § 9 delivery plan. Where this plan and the design doc
diverge, the divergence is a defect (spec § Assumptions).

## Summary

Extend RBAC from three hardcoded roles (`admin`, `manager`, `member`) to five
(`+ super_admin`, `+ marketing`) backed by a **permission catalogue + per-role bundles
defined as pure data in the auth Domain layer** (Phase 1 — no DB tables, no role editor;
Phase 2 parked with explicit triggers). Convert all ~175 role-string authorization checks
(4 call-site pattern classes + the nav/palette data surface) into positive permission
checks behind the `FEATURE_RBAC_V2` flag, with a per-call-site-class compatibility shim
keeping flag-OFF byte-identical to observed production behaviour. Cutover sequence:
PR 1 (dark domain) → PR 2 (flag-gated sweep) → D18 pre-mint + flag ON + Migration C
(operator-gated promotion of human admins) → PR 3 (users page) → PR 4 (nav/insights split,
marketing assignable, flag default ON) → PR 5 (legacy deletion, strict trigger).
Prod is LIVE with real members + money — zero-lockout and behaviour preservation are
hard requirements (SC-002, SC-006).

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`); Node 22 LTS — unchanged from F1–F9
**Primary Dependencies**: Next.js 16 App Router · React 19 · Drizzle ORM · next-intl ·
Vitest/Playwright/axe. **Zero new npm dependencies** (Constitution X)
**Storage**: Neon Postgres `ap-southeast-1` (Drizzle). **No new tables, no column drops.**
DDL: role pgEnum `+= 'super_admin','marketing'` (Migration A) · audit_event_type
`+= 'permission_denied'` (Migration B) · `users_last_admin_guard()` rewritten to
transitional UNION population (B) then strict (PR 5) · Migration C = data-only promotion
UPDATE (users + open invitations), its own migration-only deploy
**Testing**: Vitest unit/contract (characterization suite flag-parameterised, both legs) ·
live-Neon integration (transaction-wrapped rehearsals with ROLLBACK on the dev branch) ·
Playwright E2E + axe (three persona assertion lists + super_admin persona)
**Target Platform**: Vercel `sin1` (prod live at `swecham.dxtspace.com`); native Vercel Cron
untouched (system actors excluded from promotion)
**Project Type**: Web application — existing modular monolith (`src/modules/*` bounded
contexts, App Router presentation)
**Performance Goals**: Evaluator is a synchronous in-memory set lookup — **zero added DB
reads on the request path**; session query shape unchanged (D15). Existing budgets hold
unchanged (API p95 < 400ms; LCP < 2.5s)
**Constraints**: Live prod with real money — flag OFF must be byte-identical to observed
behaviour (anti-circularity rule); zero staff-lockout minutes across cutover (SC-006);
promotion must be technically incapable of riding an ordinary deploy (D7); no BE dates,
no PII in logs (`permission_denied` payload pinned — route path without query string)
**Scale/Scope**: ~175 call sites across ~120 files (4 pattern classes) + nav/palette data ·
17 currently-ungated staff pages · 40-key pinned catalogue · 5 roles · 6 delivery steps
(5 PRs + 1 migration-only deploy) · 3 system-actor rows excluded from promotion

## Constitution Check

*GATE: evaluated against Constitution v1.4.2 (all 10 principles) — pre-Phase-0 PASS,
re-checked post-Phase-1 design (see § Post-Design Re-check).*

**NON-NEGOTIABLE gates**:

- [x] **I. Data Privacy & Security** — This feature IS the RBAC hardening: 17 ungated
      staff pages gain positive permission gates; deny-list escalation paths closed;
      erasure surfaces become `superAdminOnly`; DoB class moves behind
      `members.pii_sensitive`; marketing gets minimised member read (no sensitive PII,
      no export, redacted activity feed). No NEW PII is collected; the new processing
      activity (staff role administration) + marketing's member-read access get ROPA
      documentation (FR-018, PR 4). Denials audited with real role; payload pinned to
      exclude query strings/tokens. Tenant isolation: single-tenant deployed; `users.role`
      is the F1 cross-tenant exception (constitution § I carve-out); D1 records that a
      second tenant REQUIRES F10 `user_tenants` before/with Phase 2. OWASP: broken access
      control is the entire subject — mitigations are the positive gates + mechanical
      coverage (SC-001) + characterization (SC-002).
- [x] **II. Test-First Development** — Characterization tests (observed behaviour, both
      flag legs) are authored BEFORE the sweep that could change behaviour; evaluator +
      bundle Domain tests precede evaluator implementation; trigger/promotion rehearsals
      run against live Neon before Migration C ships. Coverage: Domain 100% line
      (blanket); evaluator + flag-reading helpers 100% branch via explicit
      `vitest.config.ts` entry (SC-007); helpers file barred from coverage-exclude lists.
- [x] **III. Clean Architecture** — Catalogue + bundles + evaluator are pure Domain data/
      functions in `src/modules/auth/domain/` (zero framework imports; flag passed as an
      explicit parameter). Env reads confined to `src/lib` helpers + façade (composition
      root, barrel-rule-exempt by constitution). ONE deviation: `src/modules/plans`
      deep-imports the pure Domain evaluator module (auth barrel = argon2 client-bundle
      hazard) → Complexity Tracking #1.
- [x] **IV. Payment Security (PCI DSS)** — No payment-path logic changes; no card data
      touched. Money surfaces are permission-MAPPED (admin keeps refund/void/credit-note
      per D3) with behaviour preservation proven by characterization. SAQ-A scope
      unchanged. New audit event: `permission_denied` (5y default retention).

**Core principle gates**:

- [x] **V. Internationalization (SV/EN/TH)** — 5 role display names × EN/TH/SV (FR-015);
      denial surfaces reuse existing 404/403 message keys; `check:i18n` in gates. No
      currency/date surface changes.
- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Users-page retrofit: role picker,
      explicit `finalFocus` on every dialog (fixes pre-existing `user-list-table.tsx`
      omission), keyboard E2E asserts focus never drops to `<body>`; axe sweeps on changed
      surfaces; nav/palette render only permitted entries (no dead links); dashboard grid
      collapses gracefully for marketing (no empty holes). Existing shared components only.
- [x] **VII. Performance & Observability** — Zero added request-path latency (synchronous
      evaluator, D15). New: `rbac.permission_denied_total{role, permission}` counter +
      structured denial log + expected-denial baseline alert (mechanically derived from
      the § 4.1 diff); runbook `docs/runbooks/rbac-v2-cutover.md`. Budgets unchanged.
- [x] **VIII. Reliability** — Error paths enumerated: denial → typed 403 / `notFound()`;
      last-super-admin refusal → typed error via `isLastAdminTriggerError` (ERRCODE 23514 +
      substring contract preserved, 3 consumers); audit emit fail-open (denial served even
      if emit fails). Transactions: Migration C is one file = atomic under the runner's
      whole-batch transaction (no literal BEGIN/COMMIT). DB-level defence-in-depth: UNION
      trigger (transitional) + strict app guard with THREE callers incl. erase-user.
      Observable-verification pattern (v1.4.1): D7 run-migrations gate assertion +
      `REQUIRED_ENUM_VALUES` Phase-3 fail-loud check + `check:staff-page-guard`.
- [x] **IX. Code Quality Standards** — TS strict, ESLint (incl. new architecture guard for
      authorization reads outside the identity allowlist), Conventional Commits. RBAC is
      security-sensitive ⇒ ≥2 reviewers required ⇒ solo-maintainer substitute invoked →
      Complexity Tracking #2 (5-check stack enumerated).
- [x] **X. Simplicity (YAGNI)** — The Phase-1 descope IS the YAGNI decision (role editor +
      DB store rejected: no business driver, 3/5 critical defect classes unique to the DB
      variant — 154-finding evidence). Accepted temporary complexity: dual-leg flag + shim
      → Complexity Tracking #3. Split keys (`invoicing.issue`, `events.relink`,
      `users.member_accounts`) are driven by CURRENT defects/needs, not speculation
      (each has a concrete failure scenario in design § 15).

## Project Structure

### Documentation (this feature)

```text
specs/016-rbac-permissions/
├── spec.md              # Feature spec (committed df7adb032)
├── plan.md              # This file
├── research.md          # Phase 0 — consolidated decisions + verified repo facts
├── data-model.md        # Phase 1 — roles, catalogue, bundles, migrations, trigger contract
├── quickstart.md        # Phase 1 — dev workflow: flag, personas, rehearsals, gates
├── contracts/
│   ├── permission-evaluator.md         # Evaluator + helpers + shim + denial contract
│   └── authorization-surfaces.md       # Page/API/nav surface contract + matrix conventions
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/modules/auth/domain/
├── role.ts                      # ROLES tuple ×5, STAFF_ROLES, PORTAL_FOR_ROLE (PR 1)
├── policies.ts                  # legacy canAccess — absorbed into shim leg, deleted PR 5
└── permissions/                 # NEW (PR 1) — pure data + pure functions, zero framework imports
    ├── permission-catalogue.ts  # PermissionKey union + flags (superAdminOnly, sensitive)
    ├── role-bundles.ts          # ROLE_BUNDLES: Record<Role, ReadonlySet<PermissionKey>>
    ├── evaluator.ts             # hasPermission(set, key, {flag}) — both legs + D16 totalisation
    └── legacy-shim.ts           # per-call-site-class shim rows (deleted PR 5)

src/lib/
├── rbac.ts                      # NEW — requirePagePermission / requireApiPermission /
│                                #   canAccess façade; the ONLY FEATURE_RBAC_V2 env reads
├── rbac-guard.ts                # existing guard — call sites migrate to rbac.ts (PR 2)
├── db-errors.ts                 # isLastAdminTriggerError — contract preserved, unchanged
└── env.ts                       # + FEATURE_RBAC_V2 (zod; default false → true in PR 4)

src/modules/auth/infrastructure/db/schema.ts   # roleEnum tuple widened (ships WITH Migration A)
src/modules/auth/application/                  # countActiveAdmins → countActiveSuperAdmins
                                               #   (3 callers: change-role, disable-user, erase-user)
src/app/(staff)/admin/**                       # PR-2 sweep: every page gains requirePagePermission
src/app/api/admin/**                           # PR-2 sweep: every handler gains requireApiPermission
                                               #   (F6 families keep legacyF6Guard semantics — D9)
src/config/nav.ts                              # PR 2: roles arrays widened; PR 4: requiredPermission
src/components/**/command-palette/**           # PR 2: if-chain sweep; PR 4: declarative
src/modules/insights/**                        # PR 4: snapshot split engagement/finance + widget map
src/i18n/messages/{en,th,sv}.json              # 5 role display names + users-page keys

drizzle/migrations/                            # A (PR 1) · B (PR 2) · C (own PR) — hand-written SQL
scripts/
├── run-migrations.ts                          # PR 2: D7 promotion-gate assertion
├── lib/enum-migration-guard.ts                # REQUIRED_ENUM_VALUES += role/audit values
├── check-staff-page-guard.ts                  # NEW gate (clones portal-guard-core precedent)
├── seed-bootstrap-admin.ts                    # PR 2: mints super_admin; refuses iff one exists (D18)
└── seed-system-actors.ts                      # SYSTEM_ACTORS = canonical exclusion list (read-only)

docs/runbooks/rbac-v2-cutover.md               # NEW — pre-mint → flag → Migration C → floor → rollback

tests/
├── unit/auth/permissions/                     # catalogue/bundle/evaluator Domain tests (100%)
├── contract/rbac/                             # characterization (both legs) + role×endpoint matrix
│                                              #   + API exhaustiveness (fs-walk) + denial-audit contract
├── integration/auth/                          # live-Neon: trigger rehearsals, Migration B/C rehearsals,
│                                              #   promotion correctness, reversed-order abort
└── e2e/                                       # persona walks (admin/manager/marketing/super_admin),
                                               #   keyboard focus, a11y + i18n sweeps
```

**Structure Decision**: Existing modular-monolith layout; the feature adds one Domain
sub-package (`auth/domain/permissions/`), one composition-root lib file (`src/lib/rbac.ts`),
three migrations, one gate script, and one runbook. No new module, no new table, no new
dependency. Presentation-layer changes are sweeps of existing files.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **#1 — Principle III: `src/modules/plans` deep-imports `auth/domain/permissions/*` (bypasses auth's public barrel)** | plans' client-adjacent code needs the pure evaluator; the flag threads from plans' own server boundary | Importing via auth's barrel transitively loads `@node-rs/argon2` (Node-only) into a client-bundle path — build breaks (066-barrel-cycle class). Duplicating the evaluator in plans drifts the single source of authorization truth. Scoped ESLint `no-restricted-imports` carve-out names the exact specifier; removed when Phase 2 restructures the barrel. |
| **#2 — Principle IX: ≥2-reviewer rule on RBAC (security-sensitive) substituted by the solo-maintainer 5-check stack** | Single maintainer; no second human reviewer exists | The 5 checks, all mandatory per PR in § 9's delivery plan: (1) ≥3 `/speckit.review` passes with decreasing severity; (2) ≥1 `/speckit.staff-review` triangulated round (correctness + security + tests), second round mandatory on any BLOCKER/CRITICAL; (3) coverage per Principle II incl. live-Neon integration for every security-critical path (trigger, promotion, guards); (4) DB-level defence-in-depth (UNION→strict trigger, run-migrations gate assertion, `REQUIRED_ENUM_VALUES`); (5) post-remediation re-review by a fresh agent. Maintainer co-signs each security checklist with the v1.4.2 footer template. Design phase already banked 3 adversarial rounds (154+24+48 findings). |
| **#3 — Principle X: dual-leg evaluator + per-call-site-class shim + characterization suite (temporary, PR 2 → PR 5)** | Prod is live with real members + money; the sweep touches ~175 authorization sites at once — a direct cutover cannot be verified against observed behaviour or rolled back without redeploying old code | Direct cutover (no flag/shim) was rejected: any wrong mapping is an instant prod access-control incident with no kill switch; review rounds 2–3 found exactly such mapping errors (manager fail-open, marketing→manager leak) that only the shim + anti-circularity characterization made visible. The complexity is bounded and scheduled for deletion in PR 5 (leg + shim + façade + env var). |
| **#4 — Development-workflow deviation: Migration C ships as its own migration-only PR + deploy, technically gated (D7), instead of riding a feature PR** | Promotion must be operator-sequenced AFTER flag-ON verification; premature application = full staff lockout (rev-1 Critical G1) | Bundling C with PR 2 (simplest) locks all staff out if the flag isn't ON at deploy time. Convention alone ("don't merge early") was rejected — round-3 SEC-R3-01 demanded technical enforcement: run-migrations pre-migrate assertion exits 1 when the promotion file is pending and `FEATURE_RBAC_V2 !== 'true'`, so a premature merge fails the build loudly instead of deploying. |
| **#5 — Principle III: the deep-import carve-out is ~135 files wide, not one module (widened by the PR-2 sweep; recorded at the PR-2 review gate)** | Entry #1 scoped this to `src/modules/plans`, written before the sweep existed. Sweeping 46 pages + ~119 API routes onto the gate means every one of them imports its shim row, and the shim / catalogue / evaluator are deliberately NOT re-exported from `src/modules/auth/index.ts`. Four `src/modules/insights/application/**` files additionally deep-import `isAdministrativeRole` as a VALUE, because the auth barrel drags `auth-deps` infrastructure singletons (argon2, Upstash, repos) into the module-eval graph — that is not theoretical, it crashed the `export-download` contract collection during PR 2. | Re-exporting the shim from the auth barrel was rejected for the same 066-barrel-cycle reason as #1, one order of magnitude larger. Passing the row from a server boundary per call site was rejected: 177 extra parameters to thread, and the whole point of the frozen `(key, row)` pair is that it is a LITERAL at the call site so `check:staff-page-guard` / `check:api-route-guard` can compare it to the baseline. **Enforcement note (016 review I7):** the ESLint `no-restricted-imports` guard Principle III relies on is already SHADOWED for `src/app/**` and `src/components/**` — flat config REPLACES rather than merges, and the later events-brand block wins. So `pnpm lint` passing here is silence, not approval. `tests/unit/architecture/auth-barrel.test.ts` is the machine-readable inventory instead: it allow-lists the permitted specifiers and pins the file COUNT, so the carve-out cannot widen quietly and PR 5 has an exact deletion list. |

## Post-Design Constitution Re-check (after Phase 0 + Phase 1 artefacts)

Re-evaluated 2026-08-10 after generating research.md, data-model.md, contracts/,
quickstart.md: no new violations introduced by the design artefacts. The four Complexity
Tracking entries remain the complete deviation set. Phase-1 artefacts introduce no new
dependency, table, or module; the contracts confirm the Domain purity pin (evaluator takes
the flag as a parameter; env reads only in `src/lib/rbac.ts`). **GATE: PASS.**

## Phase Outputs

- **Phase 0**: [research.md](./research.md) — no open NEEDS CLARIFICATION (all resolved
  across the brainstorming session + three review rounds; consolidated as Decision /
  Rationale / Alternatives with verified repo facts pinned).
- **Phase 1**: [data-model.md](./data-model.md) · [contracts/permission-evaluator.md](./contracts/permission-evaluator.md) ·
  [contracts/authorization-surfaces.md](./contracts/authorization-surfaces.md) ·
  [quickstart.md](./quickstart.md) · agent context updated via
  `.specify/scripts/powershell/update-agent-context.ps1 -AgentType claude`.
- **Phase 2**: tasks.md — produced by `/speckit.tasks`, not by this command.
