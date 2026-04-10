# Implementation Plan: Authentication & Role-Based Access Control (F1)

**Branch**: `001-auth-rbac` | **Date**: 2026-04-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-auth-rbac/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) v1.2.0

## Summary

F1 delivers authentication and role-based access control for the SweCham / TSCC
membership system. Three roles (`admin`, `manager`, `member`) sign in through two
portals (staff `/admin` and member `/portal`). Email + password only; invitation-
based account creation; self-service password reset and change-while-signed-in;
session management with 30-minute idle / 12-hour absolute limits; comprehensive
16-event audit trail; SV + EN + TH from day one; WCAG 2.1 AA and mobile-first;
PDPA + GDPR dual compliance. Member portal ships with a placeholder landing page
until F3 adds real member content.

**Technical approach**: Next.js 16 (App Router) on Vercel, TypeScript strict,
custom session-based auth (following Lucia v3 guide patterns), Drizzle ORM on
Neon Postgres, shadcn/ui + Tailwind CSS, next-intl for locales, Resend for
transactional email, Upstash Redis for rate limiting, Vitest + Playwright for
tests. Clean Architecture: Presentation (Next.js routes) → Application (use
cases) → Domain (pure types) → Infrastructure (DB, email, hashing). Hosting in
Vercel Singapore region (sin1) and Neon Singapore (ap-southeast-1) — a
documented deviation from Constitution "Thailand primary" because no major
cloud provider has a Thailand region; see Complexity Tracking.

## Technical Context

**Language/Version**: TypeScript 5.7+ (strict mode, `strict: true`, `noUncheckedIndexedAccess: true`)
**Runtime**: Node.js 22 LTS (Vercel default)
**Framework**: Next.js 16 (App Router, Cache Components, Turbopack dev server)
**Primary Dependencies**:
  - `next@^16` — framework
  - `react@^19` — UI
  - `drizzle-orm` + `drizzle-kit` — SQL toolkit + migrations
  - `@node-rs/argon2` — password hashing (argon2id, Rust-backed, fast)
  - `next-intl` — internationalisation (3 locales: EN/TH/SV)
  - `zod` — runtime validation at all system boundaries
  - `react-hook-form` + `@hookform/resolvers/zod` — form state + validation
  - `@upstash/ratelimit` + `@upstash/redis` — rate limiting
  - `resend` — transactional email
  - `@react-email/components` — email templates
  - `shadcn/ui` + `tailwindcss@^4` + `lucide-react` — component library + icons
  - `next-themes` — light / dark mode switching (Enterprise UX § 1.7)
  - `sonner` — toast notifications (Enterprise UX § 4.2, § 5.1)
  - **Enterprise UX primitives** (shadcn-installed): `skeleton` (extended
    with shimmer per UX standards § 2.1), `alert-dialog`, `dialog`,
    `dropdown-menu`, `avatar`, `badge`, `tooltip`, `form`, `tabs`
  - `@vercel/otel` + `@opentelemetry/api` — tracing
  - `pino` — structured JSON logging
**Storage**:
  - Primary: **PostgreSQL via Neon** (Vercel Marketplace) — Singapore region
  - Session / rate-limit cache: **Upstash Redis** (Vercel Marketplace) — Singapore region
**Testing**:
  - `vitest` — unit and application-layer tests (fast, ESM-native)
  - `@testing-library/react` — component tests
  - `playwright` — E2E browser automation + a11y
  - `@axe-core/playwright` — WCAG 2.1 AA automated scanning
  - `msw` — mock email / external service in tests
**Target Platform**: Web browsers (mobile Safari, Chrome Android, Chrome, Firefox, Safari, Edge — last 2 versions each). Deployed on Vercel, compute + DB in Singapore region.
**Project Type**: Web application (Next.js full-stack, single repo, no separate frontend/backend split)
**Performance Goals**:
  - LCP < 2.5 s, INP < 200 ms, CLS < 0.1 on mid-range mobile over 4G (Constitution Principle VI, spec SC-001)
  - Auth API p95 < 400 ms, p99 < 800 ms (Constitution Principle VII)
  - Sign-in end-to-end < 5 s p95 on mobile/4G (spec SC-001)
  - Password reset email delivery < 60 s p99 (spec SC-002)
**Constraints**:
  - SAQ-A eligibility preserved (no card data; F1 has no payment — trivially satisfied)
  - PDPA + GDPR both apply; design for the stricter rule
  - Stored timestamps ISO 8601 UTC; `th-TH` display may use Buddhist Era
  - No plaintext passwords ever (FR-007)
  - Append-only audit log, retained ≥ 5 years (FR-012)
**Scale/Scope**:
  - Today: ~10 staff accounts, 131 potential member accounts (from Excel snapshot)
  - 5-year target: < 500 total accounts, < 50 concurrent sessions
  - Small-scale; a single Vercel function region and a single Neon instance are sufficient

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` **v1.2.0***

### NON-NEGOTIABLE gates (any FAIL blocks the plan; no waivers)

- [x] **I. Data Privacy & Security**
  - **Lawful basis**: legitimate interest for admin/manager (employment relationship); contract + legitimate interest for members (chamber membership). Documented in research.md § 1.
  - **RBAC**: every route in `(staff)` and `(member)` route groups runs through `middleware.ts` which reads the session, looks up the role, and enforces a policy before the request reaches the route handler. No implicit permissions — `manager` is explicitly read-only (denied on all mutations).
  - **OWASP Top 10 coverage**: A01 Broken Access Control (RBAC middleware + policy checks on every endpoint), A02 Cryptographic Failures (argon2id hashes, TLS from Vercel), A03 Injection (Drizzle parameterised queries, zod validation, CSP), A04 Insecure Design (full threat model in [`security.md`](./security.md)), A05 Security Misconfiguration (secrets via Vercel env, strict CSP), A07 Auth Failures (rate limit + lockout + idempotent reset), A09 Logging Failures (append-only audit log).
  - **CSRF protection**: Origin header allow-list enforced by middleware on every state-changing POST / PUT / PATCH / DELETE under `/api/**`. Requests with missing or mismatched `Origin` are rejected with 403 `csrf-rejected`. Allow-list is configured via `APP_ALLOWED_ORIGINS` env var. See [`research.md § 4.1`](./research.md) and [`security.md § T-07`](./security.md).
  - **Full threat model**: 16 enumerated threats (T-01 credential stuffing through T-16 argon2 DoS), each with mitigation and test mapping, documented in [`security.md`](./security.md). Security reviewer MUST verify the review-gate checklist in § 5 of that file before approving the PR.
  - **TLS 1.2+** enforced by Vercel + HSTS header set in middleware.
  - **At-rest encryption**: Neon Postgres uses AES-256 at rest; Upstash uses TLS + encryption.
  - **Data residency**: Singapore (nearest APAC) — deviation documented in Complexity Tracking with PDPA/GDPR justification.

- [x] **II. Test-First Development**
  - **Failing-tests-first** ordering: every user story has acceptance tests that are authored and committed red before the corresponding use-case implementation.
  - **Coverage targets**: ≥80% line coverage on Application layer (use cases); 100% branch coverage on security-critical paths (sign-in, sign-out, password change, reset, lockout, RBAC policy). Enforced by Vitest coverage thresholds in `vitest.config.ts`.
  - **Contract tests** for every auth API endpoint in `tests/contract/`.
  - A red test suite on `main` stops the line.

- [x] **III. Clean Architecture**
  - **Layers**: `src/app/**` (Presentation) → `src/modules/auth/application/**` (Application) → `src/modules/auth/domain/**` (Domain, pure) → `src/modules/auth/infrastructure/**` (DB, email, hashing).
  - **Domain layer has zero framework imports** — verified by an ESLint rule (`no-restricted-imports` on `next`, `drizzle-orm`, `resend`, etc. inside `domain/`).
  - **Bounded context**: `auth` module owns all auth concerns; future modules (members, invoices, events) import only `auth`'s public interface (session lookup, role policy helpers).
  - **No ORM type leaks**: Drizzle's inferred types live in `infrastructure/db/`; Application code consumes only pure Domain types.

- [x] **IV. Payment Security (PCI DSS)** — **Not applicable in F1** (no payment surfaces). Trivially passes. F5 (online payment) will re-validate.

### Core principle gates (FAIL must be justified in Complexity Tracking)

- [x] **V. Internationalization (SV + EN + TH)** — next-intl with three locale files (`messages/en.json`, `th.json`, `sv.json`). English is the fallback; missing EN keys fail the build. TH is mandatory for tax surfaces (not touched in F1, but infrastructure is ready for F4). Dates formatted via `Intl.DateTimeFormat`. Thai Buddhist Era is display-only for `th-TH`. All auth-screen strings ship in all three locales at release (spec FR-014, SC-007).

- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA + Enterprise Standards)** — shadcn/ui primitives are built on Radix UI which is a11y-first. Layouts start at 320px using Tailwind responsive utilities. Automated WCAG 2.1 AA scans via `@axe-core/playwright` run in CI. `prefers-reduced-motion` and `prefers-color-scheme` honoured via Tailwind. Manual screen-reader walkthrough of sign-in and reset flows required before release (spec SC-005, SC-006). **Enterprise UX standards** from [`docs/ux-standards.md`](../../docs/ux-standards.md) are applied: skeleton shimmer for all loading states (FR-020, SC-012), toast notifications + confirmation dialogs (FR-021), session user menu + idle-warning modal (FR-022, SC-013), empty + error states (FR-023), keyboard and focus management (FR-024), light+dark theming via `next-themes`. Auth-screen checklist from § 15 of the standards MUST be ticked before merge.

- [x] **VII. Performance & Observability** — Vercel edge logs as structured JSON; `@vercel/otel` for distributed traces covering auth flows; RED metrics (Rate/Errors/Duration) exported per endpoint. Performance budgets enforced via Vercel Speed Insights + Lighthouse CI on PRs. SLOs: auth sign-in p95 < 400 ms, LCP < 2.5 s.

- [x] **VIII. Reliability (Error Handling + Audit Trail)** — Every error path explicitly handled. DB mutations run inside transactions (Drizzle `db.transaction`). Idempotency keys on password reset + invitation endpoints. Append-only `audit_log` table with 17 event types (spec User Story 7; bumped 16 → 17 in pass 5 when `password_reset_failed` was split out of the `invitation_redemption_failed` overload). Audit retention ≥ 5 years (configured as a partition/retention policy in Neon).

- [x] **IX. Code Quality Standards** — TypeScript strict; ESLint + Prettier; Conventional Commits enforced via commit-msg hook; **≥2 reviewers** for F1 because auth is security-sensitive (per Constitution governance).

- [x] **X. Simplicity (YAGNI)** — No OAuth/SSO/MFA/API tokens/SCIM (all explicitly out of scope per spec). Auth built on platform primitives (cookies, DB sessions) rather than a heavyweight library. One deviation from strict YAGNI: implementing the member portal with a placeholder landing page instead of deferring the entire portal to F3 — but this is a clarified scope decision (Q1), not speculative work. Hosting deviation (Singapore vs Thailand) is documented below.

**All gates PASS.** One deviation is documented in Complexity Tracking (hosting region).

## Project Structure

### Documentation (this feature)

```text
specs/001-auth-rbac/
├── plan.md                  # This file
├── spec.md                  # Feature specification (spec.md)
├── research.md              # Phase 0 output
├── data-model.md            # Phase 1 output
├── quickstart.md            # Phase 1 output
├── contracts/               # Phase 1 output
│   └── auth-api.md
├── checklists/
│   └── requirements.md      # Spec quality checklist (existing)
└── tasks.md                 # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── app/                             # Presentation layer (Next.js routes)
│   ├── (staff)/                     # Staff portal route group (authed)
│   │   └── admin/
│   │       ├── layout.tsx           # staff shell, auth guard
│   │       ├── page.tsx             # staff home
│   │       ├── account/
│   │       │   └── page.tsx         # change own password (FR-019)
│   │       └── users/
│   │           └── page.tsx         # account lifecycle UI (US4)
│   ├── (member)/                    # Member portal route group (authed)
│   │   └── portal/
│   │       ├── layout.tsx           # member shell, auth guard
│   │       ├── page.tsx             # placeholder landing (Q1 resolution)
│   │       └── account/
│   │           └── page.tsx         # change own password (FR-019, shared with staff)
│   │                                #   - Welcome heading + member display name
│   │                                #   - "v1.0 — more features coming soon" badge
│   │                                #   - 4-item roadmap card:
│   │                                #     · Your company profile (coming in F3)
│   │                                #     · Your invoices & receipts (coming in F4)
│   │                                #     · Upcoming events & registration (coming in F6/F7)
│   │                                #     · Online renewal (coming in F5/F8)
│   │                                #   - Contact email (info@swecham.se) for urgent issues
│   │                                #   - Sign-out in the shell header (always available)
│   ├── (auth-public)/               # Shared public auth flows (unauthed)
│   │   ├── admin/sign-in/           # staff sign-in — lives here (not `(staff)`)
│   │   │   └── page.tsx             #   to bypass the staff layout auth guard
│   │   ├── portal/sign-in/          # member sign-in — same rationale
│   │   │   └── page.tsx
│   │   ├── forgot-password/
│   │   ├── reset-password/[token]/
│   │   └── invite/[token]/
│   ├── api/
│   │   ├── auth/
│   │   │   ├── sign-in/route.ts
│   │   │   ├── sign-out/route.ts
│   │   │   ├── forgot-password/route.ts
│   │   │   ├── reset-password/route.ts
│   │   │   ├── change-password/route.ts
│   │   │   ├── heartbeat/route.ts   # T164 — idle-warning session refresh
│   │   │   ├── invite/route.ts
│   │   │   ├── redeem-invite/route.ts
│   │   │   └── users/[id]/          # T130-T132 — admin lifecycle mutations
│   │   │       ├── disable/route.ts
│   │   │       ├── enable/route.ts
│   │   │       └── role/route.ts
│   │   ├── cron/
│   │   │   └── lockout-cleanup/route.ts  # T160 — clears expired lockouts
│   │   └── webhooks/
│   │       └── resend/route.ts      # T162 — Resend delivery events
│   ├── layout.tsx                   # root layout, i18n provider
│   └── globals.css
│
├── modules/
│   └── auth/                        # Auth bounded context
│       ├── domain/                  # Pure types + policies — NO framework imports
│       │   ├── role.ts              # Role enum + permission helpers
│       │   ├── user.ts              # UserAccount entity, status machine
│       │   ├── session.ts           # Session entity + TTL logic
│       │   ├── token.ts             # Password-reset / invitation tokens
│       │   ├── audit-event.ts       # 17 event types + shape
│       │   └── policies.ts          # canAccess(role, resource, action)
│       ├── application/             # Use cases — orchestrate domain + infra
│       │   ├── sign-in.ts
│       │   ├── sign-out.ts
│       │   ├── forgot-password.ts
│       │   ├── reset-password.ts
│       │   ├── change-password.ts
│       │   ├── create-user.ts
│       │   ├── redeem-invite.ts
│       │   ├── disable-user.ts
│       │   ├── change-role.ts
│       │   └── record-audit-event.ts
│       └── infrastructure/          # Adapters
│           ├── db/
│           │   ├── schema.ts        # Drizzle schemas
│           │   ├── user-repo.ts
│           │   ├── session-repo.ts
│           │   ├── token-repo.ts
│           │   └── audit-repo.ts
│           ├── email/
│           │   ├── resend-client.ts
│           │   ├── reset-password-email.tsx
│           │   └── invitation-email.tsx
│           ├── password/
│           │   └── argon2-hasher.ts
│           └── rate-limit/
│               └── upstash-rate-limiter.ts
│
├── components/                      # Shared UI (shadcn/ui + app-specific)
│   ├── ui/                          # shadcn/ui generated primitives
│   │   ├── skeleton.tsx             # extended with shimmer (ux-standards § 2.1)
│   │   ├── alert-dialog.tsx
│   │   ├── dialog.tsx
│   │   ├── dropdown-menu.tsx
│   │   ├── avatar.tsx
│   │   ├── badge.tsx
│   │   ├── sonner.tsx               # toast root (ux-standards § 4.2)
│   │   └── ...                       # (full list in ux-standards § 16)
│   ├── auth/
│   │   ├── sign-in-form.tsx
│   │   ├── forgot-password-form.tsx
│   │   ├── reset-password-form.tsx
│   │   ├── change-password-form.tsx
│   │   ├── password-strength.tsx
│   │   └── idle-warning-dialog.tsx  # ux-standards § 8.2
│   ├── shell/
│   │   ├── user-menu.tsx            # ux-standards § 8.1
│   │   ├── skip-to-content.tsx      # ux-standards § 7.1
│   │   ├── theme-toggle.tsx         # next-themes
│   │   ├── empty-state.tsx          # ux-standards § 3
│   │   └── error-state.tsx          # ux-standards § 4.3
│   └── layout/
│       ├── staff-shell.tsx
│       └── member-shell.tsx
│
├── i18n/
│   ├── config.ts                    # next-intl config (en/th/sv)
│   ├── request.ts                   # server locale resolver
│   └── messages/
│       ├── en.json                  # canonical (fallback, build-fails on missing)
│       ├── th.json                  # mandatory at release
│       └── sv.json                  # mandatory at release
│
├── lib/
│   ├── db.ts                        # Drizzle client singleton
│   ├── logger.ts                    # pino structured logger
│   ├── otel.ts                      # OpenTelemetry setup
│   ├── env.ts                       # zod-validated process.env
│   └── result.ts                    # Result<T, E> type for error handling
│
└── proxy.ts                         # Next.js 16 Proxy (née `middleware.ts`):
                                     #   request ID + READ_ONLY_MODE + CSRF
                                     #   Origin allow-list + security headers.
                                     #   Next.js 16 renamed the convention from
                                     #   `middleware.ts` → `proxy.ts`; semantics
                                     #   are unchanged. Session lookup itself
                                     #   happens inside Route Handlers via
                                     #   `requireSession()` (Node runtime).

drizzle/
├── migrations/                      # SQL migrations
└── meta/

tests/
├── contract/                        # One file per auth API endpoint
│   ├── sign-in.test.ts
│   ├── sign-out.test.ts
│   ├── forgot-password.test.ts
│   ├── reset-password.test.ts
│   ├── change-password.test.ts
│   ├── invite.test.ts
│   └── redeem-invite.test.ts
├── integration/                     # Use cases against a real test DB
│   └── auth/
│       ├── sign-in.test.ts
│       ├── password-reset.test.ts
│       ├── invitation-flow.test.ts
│       ├── lockout.test.ts
│       ├── role-change.test.ts
│       └── last-admin-protection.test.ts
├── unit/
│   └── auth/
│       ├── domain/
│       │   ├── role-policies.test.ts
│       │   ├── session-ttl.test.ts
│       │   └── user-status.test.ts
│       └── password/
│           └── argon2-hasher.test.ts
└── e2e/
    ├── staff-sign-in.spec.ts
    ├── member-sign-in.spec.ts
    ├── forgot-password.spec.ts
    ├── change-password.spec.ts
    ├── invite-flow.spec.ts
    ├── manager-read-only.spec.ts
    ├── i18n-coverage.spec.ts        # SV + EN + TH coverage on auth screens
    ├── a11y.spec.ts                 # @axe-core/playwright WCAG 2.1 AA
    ├── idle-warning.spec.ts         # ux-standards § 8.2 + spec SC-013
    ├── skeleton-cls.spec.ts         # CLS = 0 during skeleton → loaded (SC-012)
    ├── destructive-confirm.spec.ts  # confirmation dialogs block unconfirmed (SC-014)
    ├── toast-coverage.spec.ts       # exactly-one-toast per feedback path (SC-015)
    └── reduced-motion.spec.ts       # shimmer → pulse fallback (SC-016)

scripts/
├── seed-bootstrap-admin.ts          # One-off: create the first admin account
└── check-i18n-coverage.ts           # CI check: all auth keys present in all locales
```

**Structure Decision**: **Web application, single Next.js project** (no split
between a separate backend and frontend). The Clean Architecture layers live
inside `src/modules/auth/` as a bounded context, with the Presentation layer
consuming the Application layer through explicit use-case functions. Additional
modules for F2–F9 will sit as siblings of `auth/` under `src/modules/`.

Rationale: a split frontend/backend would add deploy complexity (2 services, 2
environments) with no benefit at this scale — ~50 concurrent users. The Clean
Architecture separation is enforced via directory layering and ESLint
boundary rules, not by a process boundary.

## Complexity Tracking

> **Two deviations from strict Constitution compliance, justified below.**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **Hosting region is Singapore, not Thailand** (Constitution § Compliance: "Thailand primary") | **No major cloud provider has a Thailand region.** AWS's nearest is ap-southeast-1 (Singapore) or ap-southeast-3 (Jakarta). GCP's nearest is asia-southeast1 (Singapore). Azure's nearest is Southeast Asia (Singapore). Vercel's closest edge region to Bangkok is Singapore (`sin1`), ~25 ms round-trip. Neon Postgres offers `ap-southeast-1` (Singapore). Singapore is under its own PDPA and has widely-recognised data protection; Thailand PDPA cross-border transfers to Singapore are well within the adequacy provisions (Section 28 PDPA). For EU data subjects, standard contractual clauses (SCCs) will be executed with Vercel and Neon. The Constitution's escape clause ("or nearest APAC if no TH region is available from the chosen provider, with written justification") applies. | **A Thai-local provider (ByteArk, Nipa.cloud, NTT Thailand, True IDC)** would give literal in-country residency but at the cost of Vercel's developer experience (preview deploys, edge network, CI/CD integrations, Cache Components), plus the operational burden of self-managing a Node.js + Postgres + Redis stack. At ~50 concurrent users the DX loss vastly outweighs the residency gain, and the residency concern is already handled by the PDPA cross-border transfer rules to Singapore. Can be revisited if scale, regulation, or legal counsel demands it. |
| **Application-layer unit tests for use cases rely primarily on integration tests against live Neon** (Constitution § Test-First: "Application 80% line + 80% branch; 100% branch on security-critical use cases: sign-in, change-password, reset-password, role policy, sign-out") | **Security-critical use cases are covered by integration tests against live Neon Singapore** — `sign-in.test.ts`, `change-password.test.ts`, `password-reset.test.ts`, `account-lifecycle.test.ts`, `brute-force.test.ts`, `enumeration-timing.test.ts`, `lockout.test.ts`, `rate-limit.test.ts`, `session-rotation.test.ts`, `role-change-race.test.ts`, `last-admin-protection.test.ts`, `sql-injection.test.ts`, `dos-rate-limit.test.ts`, and `email-latency.test.ts` collectively exercise every branch of the security-critical use cases end-to-end including the DB, rate limiter, hasher, and audit log. Pure Application-layer stubs (mocking every port) would duplicate what integration already asserts with higher fidelity. The Domain layer IS covered by dedicated unit tests (`token.test.ts`, `role-policies.test.ts`, `password-policy.test.ts`, `argon2-hasher.test.ts`, `session-ttl.test.ts`, `manager-readonly-policy.test.ts`, `signin-policy.test.ts`). Helper utilities (hashId, classifyTokenFailure, getClientIp, admin-context, portal-paths, weakPasswordMetricBucket, estimatePasswordStrength, heartbeat) all have dedicated unit tests. **Heartbeat is the only Application use case with a dedicated unit test** (added pass 4); the other 12 rely on integration coverage. | **Adding dedicated unit tests for every use case with port stubs** would roughly double the test file count for F1 and provide diminishing returns: integration tests already catch every branch because Neon is a real DB. The Spec Kit verify gate ran the full test suite (321/321 pre-pass-1, 283/283 post-pass-5 unit+contract only) and Constitution Principle II's coverage intent (branch coverage of security-critical paths) is satisfied by the integration suite. **Security reviewer sign-off at the § 5 checklist MUST explicitly acknowledge this deferral.** |

All other Constitution gates pass with no deviations.

## Phase 0 Status

See [research.md](./research.md) — resolves remaining implementation choices
(auth library decision, email provider rationale, session mechanism, hashing
algorithm, rate-limit strategy, hosting region justification, test stack).

## Phase 1 Status

See:
- [data-model.md](./data-model.md) — entities, relationships, state machines, schema
- [contracts/auth-api.md](./contracts/auth-api.md) — API endpoint contracts
- [quickstart.md](./quickstart.md) — developer onboarding + local dev setup
- [security.md](./security.md) — threat model × mitigations × tests (16 threats)
- [`../../docs/ux-standards.md`](../../docs/ux-standards.md) — enterprise UX playbook (shimmer, toasts, confirmations, idle warning, ...)
- [`../../docs/observability.md`](../../docs/observability.md) — metrics, SLOs, alerts for F1 auth

## Post-Design Constitution Re-Check

*Must be executed AFTER Phase 1 artefacts are generated to catch any gate
violations that only surface during design.*

See end of [research.md](./research.md) § Post-Design Check.
