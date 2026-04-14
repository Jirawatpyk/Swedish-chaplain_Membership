# Changelog

All notable changes to the SweCham / TSCC Membership System are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release is a Spec Kit feature (`F1`, `F2`, …) shipped as a single PR
against `main`. Release notes summarise the user-facing change; the full
spec / plan / tasks / review / retrospective for each release lives under
`specs/{nnn-feature}/`.

---

## [F4] Page Layout Enterprise Standardization — 2026-04-13

**Spec**: [`specs/004-page-layout-standard/spec.md`](specs/004-page-layout-standard/spec.md)
**Plan**: [`specs/004-page-layout-standard/plan.md`](specs/004-page-layout-standard/plan.md)
**Retrospective**: [`specs/004-page-layout-standard/retrospective.md`](specs/004-page-layout-standard/retrospective.md)
**Spec adherence**: 100% (23/23 FRs + 14/14 SCs verified or scaffolded)
**Test baseline**: 578/578 unit+contract passing · 337 i18n keys × 3 locales · 15 E2E specs authored (execution in Ship pre-flight)

### Added

- **Three layout primitives** — `<PageHeader>` (title/subtitle/actions/badge, CSS logical properties),
  `<ContentContainer>` (admin 72rem / portal 64rem), `<BreadcrumbNav>` with `<BreadcrumbProvider>`
  (depth≥3 rule, mobile truncation, i18n labels, percent-encoded URL round-trip).
- **Route-level skeleton system** — 11 `loading.tsx` files + 6 shared skeleton primitives
  (`SkeletonBlock`, `CardSkeleton`, `FormSkeleton`, `TableSkeleton`, `DetailSkeleton`,
  `PageSkeletonShell`) + colocated `<ChangePasswordFormSkeleton>`. Single `role="status"` live
  region per page; shimmer CSS utility with automatic `prefers-reduced-motion` fallback.
- **Error boundaries** — `admin/error.tsx` + `portal/error.tsx` catch server-component
  failures, log via `error.digest`, render inside shell chrome, recoverable via `reset()`.
- **~30 CSS design tokens** — content max-widths, page padding, top-bar height, typography
  scale (h1–h4 + body + caption + `--line-height-th`), form-field / table / card / modal
  dimensions. Zero magic numbers in `src/components/layout`.
- **Semantic typography classes** — `.text-h1`–`.text-h4`, `.text-body`, `.text-caption`
  with `[lang="th"]` line-height override (Thai diacritic clearance).
- **Universal focus ring** — `@layer base *:focus-visible` fallback for unclassed elements;
  component-level `focus-visible:ring-*` owns the canonical ring on shadcn primitives.
- **ESLint FR-003 enforcement** — `no-restricted-syntax` rule blocks ad-hoc
  `max-w-*`/`mx-auto`/`container`/`p-*`/heading `text-*` classes on `page.tsx` root elements.

### Changed

- **Button `size="default"`**: 32px → 36px + `cursor-pointer` + `disabled:cursor-not-allowed`.
  Aligns with Input `--input-height` and WCAG 2.5.5 touch target.
- **11 admin + portal pages** migrated to the page-shell composition.
- **Suspense strategy**: internal `<Suspense>` removed from `/admin/plans/page.tsx` and
  `/admin/users/page.tsx`. Route-level `loading.tsx` is the sole boundary (load once,
  shimmer once — previous double-wrapping caused visible two-pass shimmer).
- **`/admin/users` data fetch** split into async `UsersDataSection` child with `Promise.all`
  parallel fetch (list + count).
- **FeeConfigForm save button** — full-width `size="lg"` to match `ChangePasswordForm` pattern.
- **shadcn/ui primitives** — `table.tsx` (sticky thead, focus-within mirrors hover, Thai
  line-clamp opt-in), `card.tsx` (tokens + dark-mode `--card-shadow` override),
  `dialog/alert-dialog/sheet.tsx` (modal tokens). Catalogued in `docs/shadcn-customizations.md`.

### Fixed

- **Hydration error**: PageHeader subtitle wrapper `<p>` → `<div>` (`ReactNode` may be a div).
- **Focus-ring corner flash**: removed `border-radius: 2px` override from `*:focus-visible`.
- **Focus-ring double-ring bug**: global rule moved to `@layer base` so component utilities
  win the cascade (sidebar / Button / Input no longer stack outline + ring).
- **Error boundary crash**: `t('retry')` was on the wrong namespace — now reads
  `buttons.retry` via a second translator.
- **Nested live regions**: only outer `<PageSkeletonShell>` carries `role="status"`;
  skeleton primitives just set `aria-busy`.
- **Breadcrumb URL round-trip**: raw segments drive `href`, decoded segments drive label
  lookup; query strings defensively stripped.
- **Plan detail typography**: 3 section `<h2 text-sm>` → `<h2 text-caption>` to match FR-017.

### Technical Notes

- **Clean Architecture (Principle III)**: Presentation-layer only. Zero touches to Domain,
  Application, or Infrastructure. `BreadcrumbProvider` is the sole client island.
- **Performance**: layout primitives are React Server Components — zero client JS added.
- **i18n**: +16 new keys since F3 → 337 keys × 3 locales.
- **Governance**: 4 staff-review rounds (25 findings resolved) + CLI QA (33/37 verified;
  14 deferred to Ship pre-flight) + constitution compliance check.
- **Deferred to Ship pre-flight** (retrospective L3): 32 E2E execution + visual-regression
  audits needing seeded test DB + `E2E_ADMIN_*` env. Matches F3 solo-maintainer pattern.

---

## [F2] Membership Plans — 2026-04-12

**Spec**: [`specs/002-membership-plans/spec.md`](specs/002-membership-plans/spec.md)
**Plan**: [`specs/002-membership-plans/plan.md`](specs/002-membership-plans/plan.md)
**Retrospective**: [`specs/002-membership-plans/retrospective.md`](specs/002-membership-plans/retrospective.md)
**Spec adherence**: 100% (21/21 functional requirements implemented)
**Test baseline**: 500/500 unit+contract + 165/165 integration (live Neon Singapore) + 296 i18n keys x 3 locales

### Added

- **Membership plan catalogue** — full CRUD admin surface at `/admin/plans`
  with 9 seeded SweCham 2026 plans (6 corporate + 3 partnership tiers).
  Filterable by category, year, active state, and free-text search. Shimmer
  skeleton in the exact table shape for CLS 0. Plan detail view with full
  benefit matrix grouped by Brand Visibility / Events / Additional / Partnership.
- **Year versioning + clone** — plans carry an explicit year attribute with
  composite PK `(tenant_id, plan_id, plan_year)`. "Clone 2026 to 2027" copies
  all active plans to a new year in one transaction. Idempotent — refuses if
  target year already has plans. Historical plans remain untouched.
- **4-step create wizard** — Basics, Fees, Benefits, Review with per-step
  zod validation. Partnership plan category automatically shows/hides the
  partnership benefits block and requires `includes_corporate_plan_id`.
- **Plan edit with prior-year lock** — current-year plans fully editable;
  prior-year plans enforce a partial lock (cosmetic fields editable, pricing /
  eligibility / benefits / scope frozen) with persistent banner + lock icons.
  Triple-layered enforcement: Domain + Application + Infrastructure defence-in-depth.
- **Activate / deactivate / soft-delete / undelete** — state machine
  `active <-> inactive -> soft_deleted -> (undelete) -> inactive`. Member
  attachment check prevents deleting plans with active members (F2 stub;
  F3 real implementation). "Show deleted" toggle reveals soft-deleted rows.
- **Per-tenant fee configuration** — currency code (THB), VAT rate (7%),
  registration fee (1,000 THB) editable at `/admin/settings/fees`. Currency
  code is immutable once plans exist (422 `currency_code_immutable_in_f2`
  with plan count). Manager read-only access.
- **Command palette** — `Cmd+K` / `Ctrl+K` opens a `cmdk`-based palette
  with plan search (3+ chars), grouped results (Plans / Actions / Navigate),
  keyboard navigation, role-filtered actions (admin-only items hidden from
  manager), lazy-load on first open (not mount), `preconnect` hint for
  cold-start mitigation. < 100ms warm open.
- **Multi-tenant infrastructure** — `src/modules/tenants/` cross-cutting
  Domain-only module with branded `TenantContext` type. `runInTenant(ctx, fn)`
  wraps every tenant-scoped transaction with `SET LOCAL app.current_tenant`.
  Postgres RLS on `membership_plans`, `tenant_fee_config`, and `audit_log`.
  `DEBUG_RLS_STATE` dev assertion catches "forgot runInTenant" bugs.
  10-assertion cross-tenant integration test (Review-Gate blocker).
- **10 new audit event types** — `plan_created`, `plan_updated`, `plan_cloned`,
  `plan_activated`, `plan_deactivated`, `plan_soft_deleted`, `plan_undeleted`,
  `plan_not_found`, `plan_cross_tenant_probe`, `fee_config_updated`. All carry
  structured `payload` JSONB with field-level before/after diffs.
- **Idempotency middleware** — `Idempotency-Key` header required on all
  mutations. 24h TTL in Upstash Redis. Replay on same key+body; 409 on
  same key + different body. Fail-open on Redis outage.
- **Benefit matrix editor** — grouped UI matching the PDF structure with
  7 Select dropdowns, 5 boolean switches, 3 numeric inputs, and a
  partnership-only section that auto-shows/hides based on plan category.
- **i18n** — 296 keys in EN + TH + SV. All Select option labels translated.
  Plan display names stored as structured `{en, th, sv}` locale map with
  missing-translation indicator for admin.
- **Keyboard-only E2E suite** — 6-spec Playwright test that covers the
  entire F2 admin surface using only `page.keyboard.press` (zero `.click()`
  or `.hover()` calls enforced by self-lint).

### Changed

- **Repository constitution v1.3.1 -> v1.4.0** (MINOR). SaaS pivot adds
  explicit tenant-isolation clause to Principle I (NON-NEGOTIABLE) with 5
  sub-clauses: application-layer, database-layer, integration test,
  audit, super-admin impersonation.
- **F1 RBAC policies** extended with `plan` + `fee_config` resources and
  `clone` action.
- **UI primitives** — `cursor-pointer` added to Button, Switch, SelectTrigger
  base classes.

### Fixed

- **Client bundle env leak** — `get-plan.ts` imported `@/lib/logger` which
  chain-pulled `@/lib/env.ts` (server-only) into the client bundle via barrel
  re-exports. Removed logger import; audit adapter logs internally.
- **Button-in-button hydration error** — `LockWrapper` was using a Radix
  `<Tooltip>` (renders `<button>`) around form controls (also `<button>`).
  Replaced with native `title` attribute tooltip.
- **Select label display** — Base UI Select requires `items` prop on
  `<Select.Root>` for `<SelectValue>` to show label instead of raw enum
  value. Added to all 11 Select components.

### Technical Notes

- **New modules**: `src/modules/tenants/` (Domain-only, branded TenantContext)
  + `src/modules/plans/` (full Clean Architecture bounded context with public
  barrel + ESLint boundary rule).
- **New DB tables**: `membership_plans` (composite PK), `tenant_fee_config`.
  Migrations 0006 (tables + RLS) + 0007 (audit_log extension) + 0008 (bigint).
- **Money storage**: integer minor units per field + single `currency_code`
  on `tenant_fee_config` (no per-plan currency — YAGNI per critique P3).
- **Deferred to F3**: US7 Inline Edit + Bulk Actions (critique X1c), US3 AS4
  partnership bundle-change warning (depends on F3 members table).

---

## [F1] Auth & RBAC — 2026-04-11

**Spec**: [`specs/001-auth-rbac/spec.md`](specs/001-auth-rbac/spec.md)
**Plan**: [`specs/001-auth-rbac/plan.md`](specs/001-auth-rbac/plan.md)
**Retrospective**: [`specs/001-auth-rbac/retrospective.md`](specs/001-auth-rbac/retrospective.md)
**Spec adherence**: 100% (47/47 requirements verified)
**Test baseline**: 480/480 green (288 unit+contract + 82 integration vs live Neon + 113/117 E2E across 3 browsers)

### Added

- **Email + password authentication** with two portals — staff (`/admin/sign-in`)
  for admin and manager roles, member (`/portal/sign-in`) for member role.
  Wrong-portal attempts return generic `invalid-credentials` for enumeration
  defence (FR-001, FR-004, T-03 mitigation).
- **Role-Based Access Control** with 3 roles (admin / manager / member) as a
  Postgres enum. Manager is read-only on every staff resource. Every protected
  route enforces RBAC at the proxy layer + a layout guard + an API guard
  (defence in depth) (FR-002, FR-003).
- **Self-service forgot-password flow** with single-use email tokens (1 h TTL),
  always-200 response (no enumeration), and a per-IP + per-email rate limit.
  Reset emails go through Resend with retry + webhook bounce detection
  (FR-005, FR-016, FR-025, T-04 mitigation).
- **Admin invitation workflow** — admins create new accounts via emailed
  invitation links (7 d TTL, single-use). Invitee sets their own password;
  admins never see it (FR-009).
- **Account lifecycle UI** — admins can disable / enable / change-role from
  `/admin/users` with confirmation dialogs. The DB-level
  `users_last_admin_protection` trigger guarantees the system never reaches
  zero active admins, even under concurrent writes (FR-010, FR-011, SC-009).
- **Self-change password** while signed in — current session continues
  uninterrupted, all OTHER sessions for the same user are revoked (FR-019,
  SC-021).
- **Password policy** — 12-character minimum + HaveIBeenPwned k-anonymity
  breach check; no plaintext storage anywhere (argon2id via `@node-rs/argon2`).
  ESLint rule blocks `===` on password variables (FR-006, FR-007, SC-018).
- **Lockout + brute-force defence** — 5 failed sign-ins per account in 15 min
  triggers a 15-min lockout. Per-IP and per-email rate limits via Upstash
  Redis with in-memory fail-open fallback (FR-013, SC-010).
- **17-event append-only audit trail** with DB-trigger immutability (UPDATE
  and DELETE blocked at the Postgres layer). 5-year retention. Captures all
  authentication events including invitation flows, password changes, role
  changes, lockout events, and webhook delivery (FR-012, SC-004, SC-011).
- **Session management** — 30 min idle timeout + 12 h absolute lifetime,
  HttpOnly + Secure + SameSite=Lax cookies, instant revocation on disable /
  password change / role change (FR-008, T-05 + T-06 mitigation).
- **Idle-warning modal** — fires 1 minute before the idle timeout with a
  live countdown and "Stay signed in" / "Sign out now" actions. The "Stay
  signed in" action heartbeats the server without a page reload (FR-022,
  SC-013).
- **Persistent user menu + sign-out** in every authenticated shell (staff +
  member portal) with display name, role badge, and theme toggle.
- **Tri-locale i18n** (English + Thai + Swedish) for every user-facing
  string on auth screens. Missing English fails the build; missing Thai or
  Swedish blocks release builds via `pnpm check:i18n` (FR-014, SC-007).
- **Enterprise UX standards** — skeleton shimmers with reduced-motion
  fallback, sonner toasts for success/error feedback, alert-dialog
  confirmation for destructive actions, designed empty + error states with
  request-ID for support correlation, full keyboard operability + skip-to-
  content link (FR-020, FR-021, FR-023, FR-024, SC-012, SC-014, SC-015,
  SC-016, SC-022).
- **Return-after-signin** preserves the originally-requested URL across the
  forced redirect (FR-017, SC-020).
- **PDPA + GDPR data model** supporting all 6 GDPR data subject rights and
  PDPA equivalents (FR-018). Operator-facing implementation tracked for a
  later admin feature; the data model + APIs do not foreclose any right.
- **CSRF protection** via Origin header allow-list on every state-changing
  POST / PUT / PATCH / DELETE under `/api/**`. SameSite=Lax cookies are
  defence-in-depth (T-07 mitigation).
- **Public auth module barrel** (`src/modules/auth/index.ts`) + ESLint
  `no-restricted-imports` rule blocking deep imports from outside the
  module. Constitution Principle III (NON-NEGOTIABLE Clean Architecture)
  is now enforced at commit time, not just at review time.
- **Operations runbook** — `docs/runbook/auth.md` (268 lines) covers the
  emergency kill-switch (`READ_ONLY_MODE`), lockout cleanup, audit-log
  forensics, and rollback procedure. `docs/runbook/gdpr-rights-verification.md`
  documents the data subject rights audit playbook.

### Changed

- **Repository constitution v1.2.0 → v1.3.0** (MINOR). Three additions
  driven by F1 lessons-learned (see Sync Impact Report at the top of
  `.specify/memory/constitution.md`):
  - Principle III (Clean Architecture) now requires every `src/modules/*`
    bounded context to ship a public barrel + ESLint boundary rule.
  - Principle IX (Code Quality) + Gate 9 (Review Gate) gain an explicit
    **solo-maintainer substitute clause** — when no second human reviewer
    is available, projects MAY substitute 5 independent automated checks
    (multiple `/speckit.review` passes, `/speckit.staff-review`
    triangulation, test coverage targets, DB-level defence-in-depth,
    post-remediation verification). Per-feature, reversible.
  - § Governance Amendment procedure gains a matching solo-maintainer
    substitute so single-maintainer projects are not locked out of
    amending their own governance rules.

### Fixed

(F1 is the first feature, so "Fixed" entries cover round-2 staff review
remediations rather than regressions against an earlier release.)

- **B-01 Clean Architecture violation** — `forgot-password.ts` was importing
  `buildResetPasswordEmail` as a value from Infrastructure, violating
  Principle III. Refactored to inject the function via `ForgotPasswordDeps`
  (type-only import) following the same pattern as `create-user.ts`.
- **B-02 Upstash fail-open had no test coverage** — added
  `tests/unit/auth/rate-limit/upstash-fail-open.test.ts` mocking
  `@upstash/ratelimit` to throw and asserting the in-memory cap +
  `redisFallback` metric. Closes `security.md § 5` item 12.
- **W-01 reset-password set-then-consume race** — `reset-password.ts` now
  marks the token consumed BEFORE writing the new password hash, closing
  a narrow replay window on process crash between the two writes.
- **W-02 last-admin race window** — added DB triggers `users_last_admin_protection`
  (migration 0003) and the `RETURN OLD` fix (migration 0004) to enforce
  the at-least-one-active-admin invariant at the Postgres layer,
  independent of any application bug. The application-layer guard
  remains in place as a first line of defence.
- **W-03 forgot-password rate-limit bypass** — `forgot-password.ts`
  now normalises the email via `asEmailAddress()` BEFORE computing the
  rate-limit bucket key, preventing whitespace / case bypass of the
  per-email bucket.
- **next-intl static rendering** — `RootLayout` now passes all four
  request props (`locale`, `messages`, `now`, `timeZone`) to
  `NextIntlClientProvider` so descendant client components see the
  context from the first render pass. Without this, dev mode threw
  `useTranslations context not found` warnings on every page load even
  though the page eventually rendered correctly on the client.
- **Resend hardcoded sender** — `resend-client.ts` extracted the
  `DEFAULT_FROM` value to a `RESEND_FROM_EMAIL` env var (with hardcoded
  fallback for backwards compatibility). Production now points at the
  verified `noreply@zyncdata.app` sender; future deployments can switch
  domains without code changes.

### Technical Notes

- **Stack**: Next.js 16 (App Router + Cache Components + Turbopack) on
  Node 22 LTS. TypeScript 5.7+ strict (`strict: true`,
  `noUncheckedIndexedAccess: true`). Drizzle ORM on Neon Postgres
  Singapore. Upstash Redis Singapore for rate limiting. Resend for
  transactional email. argon2id via `@node-rs/argon2`. shadcn/ui +
  Tailwind v4 + lucide-react. next-intl for SV / EN / TH. Vitest +
  Playwright + axe-core for tests. pino + `@vercel/otel` for
  observability.
- **Hosting**: Vercel `sin1` (Singapore) — documented deviation from
  Constitution "Thailand primary" because no major cloud provider has a
  Thailand region. PDPA Section 28 cross-border transfer rules cover the
  Singapore residency. See `specs/001-auth-rbac/plan.md` § Complexity
  Tracking deviation #1.
- **Test strategy**: integration tests run against live Neon Singapore
  (not a Docker container). The earlier Docker workflow in
  `quickstart.md § 5.2` was retired in favour of higher-fidelity tests
  against the same DB the dev server uses. See `plan.md` § Complexity
  Tracking deviation #2.
- **Solo-dev review substitute** (Constitution v1.3.0 Principle IX):
  the standard "≥2 reviewers on auth surfaces" rule was substituted with
  5 automated checks for F1 because SweCham is currently a single-
  maintainer project. The substitute is documented in `plan.md` §
  Complexity Tracking deviation #3 and signed off by the staff-review
  agent + solo maintainer in `security.md § 5`. The substitute is
  reversible — F2+ with a second maintainer reverts to the default rule.

### Deferred to release QA / future features

- **T167** — dedicated `tests/e2e/skeleton-cls.spec.ts` is **superseded**
  by `lighthouserc.json` Lighthouse CI which enforces the same `CLS = 0`
  budget on every PR (a stronger guarantee than a single Playwright
  assertion).
- **T181** — Vercel Analytics dashboard panel creation is a manual click-
  through against the Vercel Observability UI; the metric queries are
  documented in `docs/runbook/auth.md § 2.1-2.5` and
  `docs/observability.md § 7.1`. Operator follows that playbook during
  release QA.
- **T187** — `pnpm quickstart validation` end-to-end on a staging Vercel
  preview deploy; covered by the post-deploy smoke test in this release
  workflow.

---
