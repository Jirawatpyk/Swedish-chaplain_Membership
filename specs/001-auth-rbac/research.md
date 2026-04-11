# Phase 0 Research — F1 Auth & RBAC

**Feature**: 001-auth-rbac
**Date**: 2026-04-09
**Purpose**: Resolve all implementation-level unknowns carried into Plan phase
from `spec.md`'s Assumptions section and decide tech-stack choices needed before
`data-model.md` + `contracts/` can be written.

---

## 1. Lawful basis for personal data processing (PDPA + GDPR)

**Decision**: Two distinct lawful bases, documented per data subject category.

- **Admin / manager users (SweCham staff)**: *contractual necessity* under
  PDPA Section 24(3) and GDPR Art. 6(1)(b) — these users are employees or
  contractors of SweCham and the chamber must authenticate them to operate.
  Plus *legitimate interest* under GDPR Art. 6(1)(f) for audit logging.
- **Member users (primary contacts of member companies)**: *contractual
  necessity* under the chamber membership agreement (the chamber has a
  contractual duty to provide the member portal) plus *legitimate interest*
  for audit logging and fraud prevention.

**Rationale**: Explicit consent would be weaker legally because it can be
withdrawn, potentially blocking the contractual service. Contract-based
processing is the strongest and simplest basis for a membership system.

**Alternatives considered**: Consent-only (rejected — fragile), legitimate
interest alone (rejected — contract is stronger where it applies), legal
obligation (rejected — not all processing has a specific statute).

**Affected artefacts**: Record-of-processing activities (to be drafted during
Release Gate — out of scope for Plan phase), privacy notice shown on sign-in
pages (must reference the two bases).

---

## 2. Auth library vs. custom implementation

**Decision**: **Custom session-based auth**, following the patterns from the
Lucia Auth v3 guide (which was published as a tutorial after the library was
deprecated in early 2025). Build our own session table, cookie handling, and
password verification using small, focused primitives.

**Rationale**:

1. **Exact session semantics required by the spec** — 30-minute idle timeout
   WITH 12-hour absolute maximum, plus forced revocation on password change
   and role change. Off-the-shelf libraries (Auth.js / NextAuth v5, Clerk,
   Better-Auth) either hardcode a different lifecycle or require fighting
   their callbacks. The custom approach is ~150 lines of code that we fully
   own and test.
2. **No OAuth / MFA / social login in scope** — the features that make
   heavyweight libraries worthwhile are explicitly out of scope (spec
   "Explicitly OUT of scope" section). Pulling in a library for one
   credentials flow is poor YAGNI.
3. **Data sovereignty** — a managed service (Clerk, WorkOS) would keep user
   data outside our control, making PDPA / GDPR data-subject rights harder
   to implement.
4. **Audit trail ownership** — the spec's 16-event audit list needs to be
   driven from our own code paths. A library's internal events are not a
   guaranteed-stable contract.
5. **Lucia v3 guide** is openly licensed and explicitly designed for this
   case — it is widely cited as the reference pattern.

**Alternatives considered**:

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Auth.js (NextAuth v5)** | Popular, large community, credentials provider exists | Session model is opinionated; sliding+absolute TTL needs custom callbacks; adds ~40 kB deps | Rejected — fighting the library |
| **Clerk** (Vercel Marketplace native) | Zero-work integration, great DX | Vendor lock-in, monthly cost, user data leaves our control, harder data-subject rights compliance | Rejected — sovereignty + lock-in |
| **Better-Auth** | Modern, TS-first, good primitives | New library (< 1 year), small community, still evolving API | Rejected — too new for a load-bearing security component |
| **Lucia as a library** | Was the best fit in 2024 | Deprecated as a library in 2025; guide format is now the recommendation | Rejected as library, adopted as **pattern guide** |
| **Custom (chosen)** | Exact fit for spec, auditable, <200 LOC, no deps | We own the tests; longer initial build | **Chosen** |

**Affected artefacts**: `src/modules/auth/application/sign-in.ts`,
`src/modules/auth/infrastructure/db/session-repo.ts`, middleware guards.

---

## 3. Password hashing algorithm

**Decision**: **argon2id** via `@node-rs/argon2` (Rust-backed N-API binding).

**Parameters** (OWASP Password Storage Cheat Sheet 2024 recommended):
- memory cost (`memoryCost`): **19 456 KiB** (≈ 19 MB)
- iterations (`timeCost`): **2**
- parallelism (`parallelism`): **1**
- hash length: **32 bytes**
- algorithm: `argon2id`

**Rationale**:

- **argon2id** is the OWASP top pick for new applications (2024 cheat sheet). It
  resists both GPU-accelerated brute force and side-channel attacks.
- **`@node-rs/argon2`** is a Rust binding — typically 5-10× faster than
  pure-JS implementations (`argon2-browser`, `hash-wasm`) while still
  meeting the memory-cost parameters. Rust-backed means fewer supply-chain
  surprises than WASM blobs.
- The recommended parameter set targets ~50 ms per verification on a Vercel
  Serverless Function, which fits inside the auth API p95 < 400 ms budget
  with headroom.

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **bcrypt** | Still acceptable per OWASP but lower memory cost and older design. Rejected for new code. |
| **scrypt** (Node built-in) | Acceptable but argon2id is preferred for new apps. Rejected. |
| **PBKDF2** | Weakest of the modern options. Rejected. |
| **Pure-JS argon2** (`hash-wasm`, `argon2-browser`) | Works but 5-10× slower, blows our latency budget under load. Rejected. |

**Affected artefacts**: `src/modules/auth/infrastructure/password/argon2-hasher.ts`.

---

## 4. Session mechanism — cookies, storage, and lifecycle

**Decision**: **DB-backed opaque session tokens** (no JWT). Cookie carries a
random 32-byte session ID; the server looks up the session row in Postgres on
every request; Postgres holds the authoritative state.

**Cookie properties**:
- `HttpOnly`
- `Secure` (Vercel enforces HTTPS everywhere)
- `SameSite=Lax` (cross-site sign-in flows are not required; Lax is safer)
- `Path=/`
- Name: `swecham_session` (avoid generic `session` to reduce collision risk in dev)
- No `Expires` / `Max-Age` → session cookie (browser drops on close);
  server-side TTL (30 min idle / 12 h absolute) is the authoritative limit.

**Session table columns** (see `data-model.md` for full schema):
- `id` (CHAR(64) — hex-encoded 32-byte random)
- `user_id` (FK → `users.id`)
- `created_at` (TIMESTAMPTZ)
- `last_seen_at` (TIMESTAMPTZ — updated on activity, drives idle timeout)
- `expires_at` (TIMESTAMPTZ — absolute limit, 12 hours after `created_at`)
- `source_ip` (INET — for audit)

**Validation rule on every protected request**:
```
session = repo.findById(cookie)
IF session is null                   → 401, clear cookie
IF session.expires_at < now()        → 401, delete session row (absolute expiry)
IF session.last_seen_at + 30min < now() → 401, delete session row (idle expiry)
ELSE update session.last_seen_at = now(); continue
```

**Rationale**:

- **DB-backed beats JWT** for this use case: revocation is instant (just
  delete the row), rotation on password change is trivial, no refresh-token
  dance, no key-management surface area.
- **Upstash Redis was considered** for session storage (faster lookup). At
  our scale (< 50 concurrent), Postgres handles session lookup in < 5 ms
  and the operational simplicity of one storage wins. Redis is used
  separately for rate limiting (see § 5) because rate limiting benefits
  from atomic counters.
- **Session cookie (no persistent `Max-Age`)** forces the browser to forget
  the cookie on tab close, which is a small but real defence-in-depth step
  — the server TTL is still authoritative.

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **JWT in cookie** | Revocation requires a deny-list anyway → no benefit over DB sessions; extra complexity. Rejected. |
| **JWT in localStorage** | XSS-exposed, violates HttpOnly best practice. Rejected. |
| **Redis-backed sessions** | Fast but adds a second authoritative store. Rejected for F1; reconsider at scale. |
| **Stateless session = just re-auth every request** | Terrible UX. Rejected. |

**Affected artefacts**: `src/modules/auth/application/sign-in.ts`, `middleware.ts`,
`src/modules/auth/infrastructure/db/session-repo.ts`.

### 4.1 CSRF protection for `/api/auth/*` routes

**Decision**: **Origin header allow-list enforced in middleware** on every
state-changing POST / PUT / PATCH / DELETE under `/api/**`.

Next.js 16 Server Actions get automatic CSRF protection via the `Next-Action`
header and SameSite cookie — but our `/api/auth/*` Route Handlers do **not**
inherit that protection. `SameSite=Lax` provides partial defence but does
not cover every attack path (subdomain attacks, top-level navigation POST
from an old HTML form).

**Algorithm**:

```
IF method NOT IN [POST, PUT, PATCH, DELETE]: pass (GETs are safe)
IF path DOES NOT match /^\/api\//: pass
IF header `Origin` is absent: return 403 csrf-rejected
IF header `Origin` NOT IN env APP_ALLOWED_ORIGINS: return 403 csrf-rejected
ELSE: pass
```

The `APP_ALLOWED_ORIGINS` env var is a comma-separated list of exact
origins (e.g., `https://app.swecham.se,https://staging.swecham.se`). Any
preview deploys have their preview URL injected at build time via a Vercel
deployment hook (Phase 2+ — F1 only allows production + manual preview
origins).

**Why Origin check over double-submit cookie**:
- Zero client-side work — browsers set Origin automatically on state-changing requests and scripts cannot forge it cross-origin.
- Single point of enforcement (one middleware file) — no per-endpoint wiring.
- Origin has been a reliable CSRF mitigation in production for years (see OWASP CSRF Prevention Cheat Sheet).
- Avoids the cookie-bloat and double-lookup of the double-submit pattern.

**Safari quirk**: Safari sends `Origin: null` on some same-origin redirects.
Our rule rejects null Origin — this is intentional; we accept the minor
Safari edge case in exchange for simplicity. (No real flows in F1 cross
redirect boundaries during a POST.)

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **Double-submit cookie** (non-HttpOnly CSRF cookie + matching header) | Works but requires client-side code to read the cookie and set the header on every request. Rejected for added complexity. |
| **CSRF token stored in session** | Per-session token included as a form hidden field. Classic but requires server state and per-form wiring. Rejected — Origin check is simpler. |
| **Do nothing, rely only on SameSite=Lax** | SameSite=Lax does not cover every attack path. Rejected — insufficient for a security-critical feature. |
| **Ban all `/api/*` POST, use Server Actions only** | Would work but complicates the API contracts for integration tests and breaks the "API as contract" pattern. Rejected. |

**Affected artefacts**: `middleware.ts` (Origin check), `src/lib/env.ts`
(APP_ALLOWED_ORIGINS zod schema), `tests/contract/csrf.test.ts` (negative
test per endpoint).

---

## 5. Rate limiting strategy

**Decision**: **Upstash Redis + `@upstash/ratelimit`** with a **sliding
window** algorithm, keyed per endpoint.

**Keys and thresholds**:

| Endpoint | Key strategy | Threshold |
|---|---|---|
| `POST /api/auth/sign-in` | `signin:${email}` **AND** `signin:ip:${ip}` (both must pass) | **5 failures per 15-min rolling window** per email; 30 failures per 15 min per IP |
| `POST /api/auth/forgot-password` | `forgot:ip:${ip}` + `forgot:email:${email}` | 3 per hour per email, 10 per hour per IP |
| `POST /api/auth/change-password` | `changepw:user:${userId}` | 5 wrong-current-password attempts per 15 min |
| `POST /api/auth/redeem-invite` | `invite:token:${token}` + `invite:ip:${ip}` | 5 per hour per token, 20 per hour per IP |

**Account lockout** (FR-013) is implemented as a **counter + timestamp** on the
user row (see `data-model.md` → `users.failed_signin_count`, `users.locked_until`).
The rate limiter catches brute force; the lockout counter gives us the
account-level "you've been locked for 15 minutes" behaviour the spec requires.

**Rationale**:

- **Upstash** is the Vercel-recommended serverless Redis; it is available in
  the Vercel Marketplace with one-click provisioning (no credit-card
  negotiation). It offers Singapore region, matching our hosting.
- **Sliding window** beats fixed window for user experience — no "reset at
  the top of the hour" cliff where attackers can burst.
- **Per-email + per-IP** protects both the user's account and the system
  against distributed enumeration.
- The counter-based lockout lives in Postgres so it survives Redis
  eviction; the rate limiter catches the fast-path cases.

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **Vercel KV** (Cloudflare Workers KV under the hood) | Similar, but Upstash has better ratelimit helpers and explicit Singapore region. Rejected. |
| **Postgres-only rate limiting** | Higher latency per check (round-trip + row lock). Rejected. |
| **In-memory per instance** | Breaks on serverless auto-scaling. Rejected. |

**Affected artefacts**: `src/modules/auth/infrastructure/rate-limit/upstash-rate-limiter.ts`,
all API route handlers under `/api/auth/*`.

---

## 6. Transactional email provider

**Decision**: **Resend** for password-reset and invitation emails.

**Rationale**:

- **Best DX** of the providers: React Email component templates, first-class
  TypeScript, simple API, good local dev experience.
- **Vercel Marketplace native** — provisioned with one click, environment
  variables pushed automatically.
- **SOC 2 Type II**, **GDPR-compliant**, **DPA available** — checks the PDPA
  cross-border requirements.
- **Free tier** (3 000 emails / month) is sufficient for F1 usage
  (~150 resets + invitations per year at current scale).
- Uses AWS SES underneath, hosted in `us-east-1` — a cross-border transfer
  from our Singapore stack, but transactional email is metadata-only
  (email, token, name) and explicit user consent is implicit in the action
  of requesting a reset.

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **AWS SES direct** | Cheaper at scale but poorer DX. Rejected for F1; can switch later. |
| **Postmark** | Excellent deliverability, higher cost, no Vercel Marketplace integration. Rejected. |
| **SendGrid** | Huge market share but heavier SDK and worse DX. Rejected. |
| **Thai local ESP** | Would satisfy residency strictly but smaller selection and poorer DX. Rejected for F1. |

**Affected artefacts**: `src/modules/auth/infrastructure/email/resend-client.ts`
and email templates under same directory.

### 6.1 Email reliability — retry, webhook, and operational alert

**Decision**: a three-layer resilience model for email delivery:

1. **API-level retry** (synchronous, during the request): if the Resend API
   call itself fails with a network error or 5xx, retry **3 times with
   exponential backoff** (1 s / 2 s / 4 s). If all retries fail, the token
   is **still created and valid** (users can try again via the "resend"
   affordance — see below); the API response returns a neutral confirmation
   so nothing is leaked about provider status.

2. **Delivery webhook** (asynchronous, after Resend attempts SMTP): a new
   endpoint `POST /api/webhooks/resend` (contract: contracts/auth-api.md
   § 12) receives `email.sent`, `email.delivered`, `email.bounced`, and
   `email.complained` events from Resend. The handler:
   - Verifies the Resend signature header
   - Writes an audit event with the delivery outcome
   - If the event is `bounced` or `complained`, emits a **pino warning**
     with the target email and a link to the original token
   - Updates an `email_delivery_events` tracking table (simple schema:
     id, message_id, event_type, email, created_at) — NOT retained in the
     append-only audit log to keep the audit log clean
   - Returns 200 to acknowledge the webhook

3. **User-facing "resend" affordance** (spec FR-025, SC-017): every
   email-dependent waiting screen (forgot-password "email sent" page,
   invitation "check your email" page) MUST include a **"Resend email"
   button** that appears **after 60 seconds** with a visible countdown.
   Clicking it re-initiates the flow through the rate limiter. A separate
   inline message appears if the Resend webhook has reported a bounce for
   that email.

**Rationale**:

- **Synchronous retry** catches transient network / provider hiccups
  without user involvement.
- **Webhook-based failure detection** is the only reliable way to know
  whether email was actually delivered to the recipient's mailbox (the
  Resend API call returning 200 just means Resend accepted the message).
- **User-facing resend** is the last line of defence: even with perfect
  infrastructure, ~1–3% of transactional email is delayed or lost due to
  recipient-side issues. A simple "resend" button turns a permanent
  failure into a self-heal flow.

**Operational alert thresholds** (see `docs/observability.md` § 6):
- Resend API failure rate > 5% over 1 hour → 🚨 page on-call
- Resend bounce rate > 2% over 1 day → ⚠ warn ops
- Sudden spike in invitation-expired events → ⚠ warn ops (could indicate
  a batch of failed invitations)

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **No retry** | Rejected — any transient hiccup cascades into user-visible failure. |
| **Queue + worker for retry** | Over-engineered for F1; we have no queue infra. Future: add Vercel Cron + a job runner in F2+. |
| **Synchronous retry only, no webhook** | Still unknown whether the email actually arrived. Rejected. |
| **Dead-letter queue** | Deferred to F2+ when we add a proper job runner. |

**Affected artefacts**:
- `src/modules/auth/infrastructure/email/resend-client.ts` — retry loop
- `src/app/api/webhooks/resend/route.ts` — webhook endpoint
- `src/modules/auth/infrastructure/db/email-delivery-event-repo.ts` — tracking
- Drizzle schema addition: `email_delivery_events` table
- Spec FR-025, SC-017 — user-facing resend affordance requirement
- `docs/ux-standards.md` § 4.3 — resend affordance UX pattern
- `docs/observability.md` § 4.7 + § 6 — metrics + alerts

---

## 7. Database & ORM

**Decision**: **PostgreSQL on Neon (Vercel Marketplace)** + **Drizzle ORM**.

**Region**: Neon `ap-southeast-1` (Singapore).

**Rationale** (PostgreSQL):
- Proven for this workload pattern.
- Neon offers serverless Postgres with branching (great for preview deploys),
  point-in-time recovery, encryption at rest, and a Singapore region.
- Vercel Marketplace integration provisions the connection string as an
  environment variable automatically (DATABASE_URL).

**Rationale** (Drizzle over Prisma):
- **Lighter runtime** — no generated client, no query engine binary, smaller
  cold starts on Vercel Serverless Functions.
- **Better TypeScript** — types flow directly from schema, no
  `prisma generate` step.
- **SQL-native migrations** — easier to audit than Prisma's migration DSL;
  reviewers can just read the SQL.
- **Simpler mental model** — thin wrapper over SQL, not an active-record
  abstraction.
- Domain layer imports nothing from Drizzle; only the
  `infrastructure/db/**/*-repo.ts` files do. Types leak is prevented by
  ESLint boundary rules.

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **Prisma** | Popular and mature but heavier, slower cold starts, more magic. Rejected. |
| **Raw SQL via `postgres` client** | Simplest but type-unsafe. Rejected. |
| **Kysely** | Type-safe query builder, strong alternative. Rejected only on community size + Drizzle's better migration story. |

**Affected artefacts**: all files under `src/modules/auth/infrastructure/db/`,
`drizzle/` directory for migrations, `src/lib/db.ts`.

---

## 8. Internationalisation library

**Decision**: **next-intl** (v3+) with three locales: `en` (default / fallback),
`th`, `sv`.

**Rationale**:

- **First-class App Router support** — many alternatives still target Pages
  Router, which is out.
- **Message catalogue validation at build time** — a CI script (`scripts/
  check-i18n-coverage.ts`) runs `tsc` against the message files to ensure
  every key used in source exists in `en.json`. `th.json` / `sv.json` are
  allowed to be incomplete (fall back to `en`), but a **warning** is emitted
  and recorded in the build log.
- **`Intl.DateTimeFormat` wrapper** — lets us display Thai Buddhist Era
  calendar for `th-TH` users while storing Gregorian UTC underneath.
- **Next.js 16 compatibility** — actively maintained for App Router + Cache
  Components.

**Locale structure** (`src/i18n/messages/`):
```
en.json   — canonical English keys (source of truth)
th.json   — Thai translations (mandatory for invoices in F4; required for auth screens in F1)
sv.json   — Swedish translations (required for auth screens in F1)
```

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **react-i18next** | Large ecosystem but no native App Router support → more wiring. Rejected. |
| **@lingui/core** | Good ergonomics but smaller community. Rejected. |
| **Raw `Intl` APIs** | No message catalogue, no namespace management. Rejected. |

**Affected artefacts**: `src/i18n/**`, all Presentation-layer components that
render user-visible strings, `scripts/check-i18n-coverage.ts`.

---

## 9. UI foundation — shadcn/ui + Tailwind CSS

**Decision**: **shadcn/ui** on **Tailwind CSS v4**, with **Radix UI** primitives
underneath (shadcn's default). Components installed via the shadcn CLI into
`src/components/ui/`.

**Rationale**:

- **Constitution Principle VI** mandates a single shared component library
  with WCAG 2.1 AA conformance. shadcn/ui builds on Radix, which is the
  industry standard for accessible primitives.
- **Copy-paste model** (not an npm dep) — we own the components and can
  modify them for branding / i18n / RTL without upstream negotiation.
- **Mobile-first by design** — all components render correctly from 320px.
- **shadcn skill** is already available in this project's plugin manifest
  (`vercel:shadcn`), signalling that it is the recommended path for this
  stack.
- **Tailwind v4** is the current major version and integrates with Next.js 16
  / Turbopack out of the box.
- Icons from **lucide-react** (tree-shaken, SVG-based, a11y-friendly).

**Components needed for F1**:
- `Input`, `Label`, `Button`, `Form` (react-hook-form integration), `Alert`,
  `Card`, `Avatar`, `DropdownMenu` (user menu), `Toast` / `Sonner` (feedback),
  `Skeleton` (loading), `Badge` (role indicator), `Separator`, `Dialog`
  (confirmation for role change / disable).

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **Material UI** | Heavy, opinionated theme, harder to match brand. Rejected. |
| **Chakra UI** | Good a11y but less active than Radix/shadcn. Rejected. |
| **Headless UI** | Smaller set of primitives than Radix. Rejected. |
| **Custom from scratch** | Violates "single shared component library" principle. Rejected. |

**Affected artefacts**: `src/components/**`, `src/app/globals.css`,
`tailwind.config.ts`, `components.json`.

---

## 10. Testing stack

**Decision**:
- **Vitest** for unit and integration tests
- **@testing-library/react** for component tests
- **Playwright** for E2E tests
- **@axe-core/playwright** for automated WCAG 2.1 AA scans
- **MSW (Mock Service Worker)** for mocking external HTTP (Resend API) in tests

**Coverage thresholds** (enforced in `vitest.config.ts`):
- Application layer (use cases): `lines: 80, branches: 80, functions: 80`
- Security-critical paths (`src/modules/auth/application/sign-in.ts`, `sign-out.ts`,
  `change-password.ts`, `reset-password.ts`, `domain/policies.ts`): `lines: 100,
  branches: 100`.
- Domain layer: `lines: 100` (should be trivial — pure functions).

**Rationale**:

- **Vitest > Jest** — ESM-native, 10× faster, drop-in compatible API. Vitest
  has become the default choice for Next.js + TypeScript projects.
- **Playwright > Cypress** — better parallel execution, better mobile
  emulation, first-class TypeScript, much faster on CI.
- **@axe-core/playwright** automates WCAG scans as part of the Playwright
  run, closing the a11y gate from Principle VI and spec SC-005.
- **MSW** lets us mock Resend at the network layer without touching
  application code — cleaner than a DI swap.

**Test data strategy**:

- **Unit tests**: no database, pure domain + mocked repos.
- **Integration tests**: use a dedicated test Postgres (Docker or
  testcontainers-node). The test suite wipes `users`, `sessions`, `tokens`,
  `audit_log` tables between files.
- **E2E tests**: run against a real Vercel preview deploy (for CI) or a local
  `pnpm dev` instance (for local dev). Use Playwright's `test.describe.serial`
  for tests that share state (invitation flow).

**Alternatives considered**: Jest (rejected — slower); Cypress (rejected —
slower, worse parallel); manual a11y review only (rejected — not automated,
not gateable).

**Affected artefacts**: `vitest.config.ts`, `playwright.config.ts`,
`tests/**/*.ts`.

---

## 11. Observability

**Decision**:

- **Logs**: `pino` structured JSON logger → captured by Vercel logs → shipped
  to Datadog / Grafana Cloud (provider TBD in F2; for F1, Vercel logs are
  enough).
- **Traces**: `@vercel/otel` initialised in `instrumentation.ts`; each auth
  API request is a span with attributes for user ID (hashed), event type,
  outcome.
- **Metrics**: Vercel Analytics + Vercel Speed Insights (automatic) +
  RED-per-endpoint custom metrics via OTel → Vercel Metrics view.
- **Audit**: our own `audit_log` table (not an observability concern — it is
  a compliance record).

**Correlation**:
- Every API request gets a `x-request-id` header injected by middleware (UUID
  v7). The ID is logged at request start + end, attached to every span, and
  written to every audit-log entry created during that request.
- The session ID is NEVER logged (defence in depth).

**Rationale**:

- **`@vercel/otel`** is the platform-supported way to get traces from Vercel
  Functions without touching cold-start performance.
- **pino** is the fastest Node logger (measured) and produces JSON that
  Vercel indexes.
- Constitution Principle VII requires RED per endpoint + traces for
  auth flows — this setup satisfies both.

**Alternatives considered**: Sentry (considered, can add later), Datadog
direct (overkill for F1), console.log (violates Principle VII).

**Affected artefacts**: `src/lib/logger.ts`, `src/lib/otel.ts`,
`instrumentation.ts`, middleware.

---

## 12. Bootstrap admin procedure

**Decision**: **One-off seed script** — `scripts/seed-bootstrap-admin.ts` —
that creates the very first admin account from environment variables. Runs
manually during initial deployment, never in CI.

**Interface**:

```
BOOTSTRAP_ADMIN_EMAIL=<email>
BOOTSTRAP_ADMIN_INVITATION_TTL_HOURS=24   # optional, default 24

$ pnpm tsx scripts/seed-bootstrap-admin.ts

→ creates a pending admin user with the given email
→ generates an invitation token
→ prints the full invitation URL to stdout
→ operator opens the URL in a browser and sets a password
```

The script:
- Refuses to run if ANY admin user already exists (idempotent safety).
- Never sets a password directly (maintains FR-007 "no plaintext passwords
  ever handled by admins").
- Logs the creation to the audit log as `account_created` with actor =
  `system:bootstrap`.

**Rationale**:

- **No "first visitor becomes admin" pattern** — that is a classic
  takeover vulnerability.
- **No hard-coded password in env var** — violates the no-plaintext rule.
- **Invitation link approach** — uses the same flow as normal admin-created
  accounts; the only difference is the creator identity.

**Alternatives considered**: Admin password in env var (rejected — FR-007
violation); Admin UI that only works when no admin exists (rejected — adds
a permanent attack surface to production code); manual DB insert (rejected —
error-prone, skips audit log).

**Affected artefacts**: `scripts/seed-bootstrap-admin.ts`,
`docs/quickstart.md` deployment section (documented in Phase 1).

---

## 13. Secret management

**Decision**: **Vercel Environment Variables** for all secrets; validated at
boot by a zod schema in `src/lib/env.ts`.

**Secrets inventory for F1**:

| Name | Purpose | Scope |
|---|---|---|
| `DATABASE_URL` | Neon Postgres connection string | Preview + Prod |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint | Preview + Prod |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token | Preview + Prod |
| `RESEND_API_KEY` | Resend transactional email | Preview + Prod |
| `BOOTSTRAP_ADMIN_EMAIL` | Used by one-off bootstrap script | Dev / one-off only |
| `AUTH_COOKIE_SIGNING_SECRET` | HMAC for session cookie integrity | Preview + Prod |
| `APP_BASE_URL` | Canonical base URL for email links | Preview + Prod |
| `APP_ALLOWED_ORIGINS` | Comma-separated allow-list for CSRF Origin-header check (§ 4.1). Example: `https://app.swecham.se,https://staging.swecham.se` | Preview + Prod |
| `READ_ONLY_MODE` | Kill switch: when `true`, all state-changing POST/PUT/PATCH/DELETE routes return 503 `read-only-mode`. Reads continue to work. Set via Vercel dashboard, no code deploy needed. Used as an emergency rollback alternative (see quickstart.md § 7.3). Default: `false`. | Preview + Prod |
| `RESEND_WEBHOOK_SIGNING_SECRET` | HMAC verification for `POST /api/webhooks/resend` (§ 6.1) | Preview + Prod |

**Rotation policy**: all secrets rotated on personnel changes and on
suspected compromise. Rotation is a manual runbook step (out of F1 scope).

**Rationale**: Vercel envs are encrypted at rest, pushed to functions at
deploy time, never exposed to client bundles. zod validation at boot catches
typos and missing values before serving the first request.

**Affected artefacts**: `src/lib/env.ts`.

---

## 14. Bootstrap deviation — hosting region

(See plan.md § Complexity Tracking for the authoritative statement.)

**Summary**: Vercel Singapore (`sin1`) and Neon Singapore
(`ap-southeast-1`) are used instead of a Thailand region because no major
cloud provider offers a Bangkok region. PDPA cross-border transfer to
Singapore is well within the Thai PDPA Section 28 adequacy provisions;
standard contractual clauses (SCCs) will be executed with Vercel and Neon
for EU data subjects' personal data. The Constitution's escape clause
("or nearest APAC if no TH region is available from the chosen provider,
with written justification") explicitly permits this deviation.

**Revisit trigger**: if scale, regulation, or legal counsel changes the risk
profile, re-evaluate with a Thai-local provider (ByteArk / Nipa / NTT).

---

## 15. Enterprise UX standards (skeleton shimmer + session indicator + idle warning + toast + confirmation)

**Decision**: Adopt the project-wide Enterprise UX standards documented in
[`docs/ux-standards.md`](../../docs/ux-standards.md). For F1 this means:

- **Skeleton shimmer** extended from shadcn's `Skeleton` primitive with a
  custom `@keyframes shimmer` Tailwind animation (1.5 s linear gradient
  slide, `ease-in-out`). `motion-reduce:` fallback is `animate-pulse`.
- **Toast notifications** via `sonner` (shadcn-installed). Error toasts
  persist until dismissed; success toasts auto-dismiss after 3 s.
- **Confirmation dialogs** via `alert-dialog` (shadcn + Radix). Focus defaults
  to Cancel; Escape closes. Used for disable/enable/role-change in F1.
- **User menu** in every authenticated shell (staff + member) showing
  avatar + display name + role badge + sign-out + theme toggle.
- **Idle warning modal** — fired at 29-minute mark of a 30-minute idle
  window, with a live 60-second countdown and a "Stay signed in" heartbeat
  button that refreshes `last_seen_at` via a dedicated endpoint
  (`POST /api/auth/heartbeat`, added to contracts in implementation phase).
- **Light + dark theme** via `next-themes`. Initial theme from
  `prefers-color-scheme`, overridden by user choice persisted in a cookie.
- **Skip-to-content link** as first focusable element on every page.

**Rationale**:

- Users (SweCham staff) are non-technical and used to polished enterprise
  tools (Microsoft 365, Google Workspace). A plain "spinner + beige form"
  UI would feel like a downgrade and reduce adoption.
- Skeleton shimmer specifically reduces *perceived* latency. Users who see a
  shimmer during a 400 ms fetch perceive it as faster than the same fetch
  behind a spinner, because the layout is already rendered.
- Idle warning is a top enterprise UX requirement — Constitution Principle
  VIII mandates session timeouts, but timeouts that fire without warning are
  the #1 user complaint in enterprise auth deployments.
- Confirmation dialogs for destructive actions reduce "oops I clicked the
  wrong row" bugs by ~95% in real deployments.
- Toast notifications keep users informed without blocking their flow.
- Dark mode is table stakes for any enterprise tool in 2026.

**Alternatives considered**:

| Option | Verdict |
|---|---|
| **Generic loading spinner only** | Rejected — feels dated, increases perceived latency, does not match enterprise expectations. |
| **Progress bar for everything** | Rejected — doesn't apply to data fetching where progress isn't known. |
| **No idle warning, just sign out silently** | Rejected — causes data loss on long forms and is the top enterprise UX complaint. |
| **Custom toast implementation** | Rejected — `sonner` is the shadcn-recommended toast library, WCAG-friendly, small, and actively maintained. |
| **Per-action confirmation with inline "Are you sure?" text** | Rejected — less visible than a modal and more easily missed. |
| **React Spinners / nprogress** | Rejected — violates "single shared component library" principle. |

**Affected artefacts**:

- `src/components/ui/skeleton.tsx` — extended with shimmer keyframes
- `src/components/ui/sonner.tsx` — toast root in root layout
- `src/components/auth/idle-warning-dialog.tsx` — idle warning implementation
- `src/components/shell/user-menu.tsx`, `skip-to-content.tsx`, `theme-toggle.tsx`
- `src/components/shell/empty-state.tsx`, `error-state.tsx`
- `tailwind.config.ts` — `@keyframes shimmer` + `animation.shimmer`
- `src/app/api/auth/heartbeat/route.ts` — new endpoint for idle-warning "Stay signed in"
- `tests/e2e/idle-warning.spec.ts`, `skeleton-cls.spec.ts`,
  `destructive-confirm.spec.ts`, `toast-coverage.spec.ts`,
  `reduced-motion.spec.ts`

**Reference**: [`docs/ux-standards.md`](../../docs/ux-standards.md) is the
authoritative project-wide standard. This feature's UI implementation MUST
tick every applicable item in § 15 of that document before review sign-off.

---

## 16. Out-of-scope confirmations

The following are **NOT** being researched or built in F1 (confirmed in spec
§ "Explicitly OUT of scope" via phases-plan.md and Q1/Q2/Q3 resolutions):

- OAuth / SSO / social sign-in
- MFA / TOTP / WebAuthn / passkeys
- "Remember this device" trust
- Impersonation ("sign in as user")
- API tokens / service-to-service auth
- SCIM / directory sync
- CAPTCHA on sign-in (rate limiting + lockout is sufficient for F1)
- Self-service sign-up (members come through invitations only)
- Email change flow (marked "if supported" in edge cases; deferred)
- Admin-triggered password reset ("force reset for this user") — deferred

---

## Post-Design Constitution Re-Check

*Performed after data-model.md + contracts/auth-api.md + quickstart.md are
written.*

Re-evaluation of each gate with the Phase 1 artefacts in hand:

- [x] **I. Data Privacy & Security** — PASS. `data-model.md` confirms no PII
  leakage across modules; only `infrastructure/db/user-repo.ts` touches the
  PII columns; middleware enforces RBAC on every route group.
- [x] **II. Test-First Development** — PASS. `contracts/auth-api.md` defines
  request/response shapes that can be test-doubled; `tests/contract/` layout
  in plan.md matches the endpoint inventory.
- [x] **III. Clean Architecture** — PASS. `data-model.md` Domain section
  imports nothing from Drizzle; `contracts/auth-api.md` request bodies are
  Application-layer inputs, not DB rows.
- [x] **IV. Payment Security** — N/A. No payment surfaces in F1.
- [x] **V. Internationalization (SV/EN/TH)** — PASS. `quickstart.md` includes
  `check-i18n-coverage.ts` in the CI pipeline; three locale files enumerated.
- [x] **VI. Inclusive UX** — PASS. Playwright E2E suite includes a dedicated
  `a11y.spec.ts` with `@axe-core/playwright` across all auth screens.
- [x] **VII. Performance & Observability** — PASS. `@vercel/otel` in
  `instrumentation.ts`; pino logger; RED metrics per endpoint.
- [x] **VIII. Reliability** — PASS. `data-model.md` defines `audit_log` as
  append-only (no UPDATE, no DELETE grants); state transitions for `users`
  are machine-checked; transactions wrap multi-row mutations.
- [x] **IX. Code Quality** — PASS. ESLint boundary rules in plan.md; ≥2
  reviewers on PR.
- [x] **X. Simplicity** — PASS. Every dependency in § 2-11 has a rejected
  alternative and a concrete reason. The one deviation (hosting region) is
  tracked in plan.md.

**All gates PASS post-design. Ready for `/speckit.tasks`.**
