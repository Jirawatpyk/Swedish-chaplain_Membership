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
