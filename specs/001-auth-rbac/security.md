# Security Model — F1 Auth & RBAC

**Feature**: 001-auth-rbac
**Status**: Active
**Date**: 2026-04-09
**Triggered by**: critique 2026-04-09 item E5 (Must-Address)
**Scope**: Threat model, mitigations, and test mapping for F1 authentication
and authorisation surfaces.

This document is the authoritative security record for F1. It is reviewed
and updated whenever auth surface area changes or a new threat is discovered.
It MUST be reviewed as part of the Review Gate (≥2 security reviewers).

---

## 1. Trust boundaries

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Untrusted: the Internet                       │
│                                                                      │
│   Browsers (staff + members + anonymous attackers + bots)            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ HTTPS (TLS 1.2+), HSTS
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Vercel Edge Network (sin1) — untrusted input surface                │
│  - request parsing                                                   │
│  - Origin header check (CSRF)                                        │
│  - rate limit (Upstash)                                              │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Next.js middleware — trust transition                               │
│  - session cookie → validated session (DB lookup)                    │
│  - RBAC policy check                                                 │
│  - request-ID correlation                                            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Application layer — trusted business logic                          │
│  - use cases (sign-in, reset, change, invite, ...)                   │
│  - constant-time password verify (argon2id)                          │
│  - audit log emit                                                    │
└────────┬─────────────────────┬─────────────────────┬─────────────────┘
         │                     │                     │
         ▼                     ▼                     ▼
  ┌──────────────┐      ┌──────────────┐       ┌──────────────┐
  │  Neon PG (SG)│      │ Upstash Redis│       │ Resend (SES) │
  │  encrypted at│      │ TLS, encrypt │       │ TLS, DPA     │
  │  rest, TLS   │      │ at rest      │       │ SCCs signed  │
  └──────────────┘      └──────────────┘       └──────────────┘
```

**Trust transitions** (where untrusted → trusted):
- T1: Internet → Vercel Edge — HTTPS terminates, WAF applies
- T2: Edge → Middleware — Origin check, rate limit, cookie parse
- T3: Middleware → Application — session validated, role asserted
- T4: Application → Infrastructure — parameterised SQL, typed clients, no string concatenation

Every transition is an **enforcement point** where input must be validated
or state must be authenticated.

---

## 2. Threat model

Enumerated threats, mitigations, and tests. Each threat is mapped to at
least one test that attempts to exploit it to verify the mitigation works.

### T-01. Credential stuffing

**Attack**: attacker has a list of email/password pairs leaked from another
site; tries them all against our sign-in endpoint.

**Mitigation**:
- **Lockout** (FR-013): 5 failed attempts per account per 15-min window → 15-min lockout
- **Rate limit** (research § 5): per-email + per-IP on `/api/auth/sign-in`
- **HaveIBeenPwned k-anonymity check** on new-password flow (see T-11)

**Tests**:
- `tests/integration/auth/lockout.test.ts` — pins the 5th-failure lock
  at the DB layer; 6th attempt returns `account-locked` from the
  sign-in use case
- `tests/integration/auth/rate-limit.test.ts` — per-IP rate-limit
  budget + 429 response
- `tests/integration/auth/brute-force.test.ts` — per-email budget;
  counts argon2 calls under load
- `tests/e2e/signin-lockout.spec.ts` — full browser UX: 5 wrong
  attempts → 6th attempt returns 403 `account-locked` → the
  "account locked" toast is rendered (not the generic
  invalid-credentials inline error). Uses the seeded
  `e2e-member@swecham.test` disposable account so production
  admins are never affected.

### T-02. Brute force (single-account)

**Attack**: attacker targets one known account and tries millions of passwords.

**Mitigation**:
- Same as T-01, plus argon2id (~50 ms per verify) makes each attempt expensive
- `SC-010`: "100 attempts per minute from a single source are effectively blocked"

**Tests**:
- `tests/integration/auth/brute-force.test.ts` — simulates 100 attempts in 60 s; asserts ≤ 5 reach the password verifier

### T-03. Email enumeration via sign-in response

**Attack**: attacker tries sign-ins with various emails; a distinct error
message or timing distinguishes "email exists but wrong password" from
"email doesn't exist".

**Mitigation**:
- **Generic 401 response** (FR-016): same message in all three cases (wrong password, unknown email, wrong portal)
- **Timing-constant verification**: on a sign-in attempt where the email
  doesn't exist, the system MUST still run a full argon2id verify against
  a **pre-computed dummy hash** so response time is indistinguishable from
  a real verification

**Implementation note**:

```ts
// src/modules/auth/application/sign-in.ts (sketch)
const DUMMY_HASH = await argon2.hash('not-a-real-password-0123456789');

export async function signIn(input: SignInInput): Promise<SignInResult> {
  const user = await userRepo.findByEmail(input.email);
  if (user === null) {
    // Intentional timing-constant: run a full verify against a dummy hash
    await argon2.verify(DUMMY_HASH, input.password);
    return { ok: false, reason: 'invalid-credentials' };
  }
  const ok = await argon2.verify(user.passwordHash, input.password);
  if (!ok) return { ok: false, reason: 'invalid-credentials' };
  // ... proceed ...
}
```

**Tests**:
- `tests/integration/auth/enumeration-timing.test.ts` — runs 100 sign-in
  attempts: 50 with a known-nonexistent email, 50 with a known-existing
  email + wrong password. Asserts the P95 latency difference is < 5 ms.
- `tests/integration/auth/enumeration-message.test.ts` — asserts the 401
  response body is byte-identical across all three failure modes.

### T-04. Email enumeration via password reset

**Attack**: attacker tries password reset for many emails; response or
timing reveals which emails exist.

**Mitigation**:
- **Always-200 response** (FR-005, contracts/auth-api.md § 3) regardless
  of whether the email is registered
- **No audit event** emitted for unknown-email reset requests (audit
  events would be a log-side enumeration vector)
- **Timing**: the handler performs a no-op "send email" path for unknown
  emails to match the real path's latency

**Tests**:
- `tests/contract/forgot-password.test.ts` — verifies identical response
  bodies for known and unknown emails
- `tests/integration/auth/reset-enumeration-timing.test.ts` — same timing
  assertion as T-03 but for the reset endpoint

### T-05. Session hijacking

**Attack**: attacker steals a session cookie via XSS, physical access to
an unlocked device, or network interception.

**Mitigation**:
- **HttpOnly cookie** — blocks JavaScript access (XSS cannot exfiltrate the
  cookie; XSS can still make requests in the user's name, but that's T-08)
- **Secure flag** — HTTPS only; Vercel enforces HTTPS site-wide
- **SameSite=Lax** — blocks cross-origin POST with credentials
- **Session cookie (no Max-Age)** — forgets on browser close as a partial
  defence against unlocked device
- **30-min idle timeout** — limits window of opportunity
- **Instant revocation** — admin can terminate any session; users can
  sign out anywhere
- **Content-Security-Policy** — reduces XSS surface area

**Tests**:
- `tests/unit/lib/auth-cookies.test.ts` — pins every cookie flag
  (HttpOnly, Secure, SameSite=Lax, Path, Max-Age) for both
  `setSessionCookie` and `clearSessionCookie`. Mocks `next/headers`
  so the options object passed to `cookies().set()` is captured and
  asserted field-by-field (review gate checklist 2026-04-10).
- `tests/contract/sign-in.test.ts` — exercises the happy + failure
  paths of the sign-in route; does NOT inspect cookie flags (the
  cookie helper is mocked wholesale).
- `tests/e2e/session-revocation.spec.ts` — verifies admin disable
  immediately ends sessions at the browser layer.

### T-06. Session fixation

**Attack**: attacker sets a known session cookie in the victim's browser,
tricks the victim into signing in; the attacker now has a valid session.

**Mitigation**:
- **New session ID issued on every sign-in** — the pre-sign-in cookie
  (if any) is discarded and a fresh 32-byte random ID is generated
- **New session ID on password change** — FR-019 mandates rotating the
  current session
- **New session ID on role change** — spec US4 acceptance scenario 4

**Tests**:
- `tests/integration/auth/session-rotation.test.ts` — verifies that a
  session cookie set before sign-in is replaced, not refreshed

### T-07. Cross-Site Request Forgery (CSRF)

**Attack**: attacker lures the victim to visit a malicious page while the
victim is signed in to the staff portal. The malicious page submits a form
to `/api/auth/users/:id/disable` — the browser sends the session cookie
automatically, and the attacker hijacks an admin action.

**Mitigation** (see research.md § 4.1 for the full implementation):
- **Origin header allow-list check** on every state-changing POST/PUT/PATCH/DELETE under `/api/**` in middleware
- Request is rejected with 403 `csrf-rejected` if:
  - `Origin` header is absent (most cross-site POST forms from old HTML)
  - `Origin` header is present but not in `APP_ALLOWED_ORIGINS` env var
- `SameSite=Lax` cookie is additional defence
- No state-changing GET endpoints exist (enforced by code review)

**Tests**:
- `tests/contract/csrf.test.ts` — one test per state-changing endpoint
  that sends the request with (a) no Origin → 403, (b) wrong Origin → 403,
  (c) correct Origin → normal response

### T-08. Cross-Site Scripting (XSS)

**Attack**: attacker injects `<script>` into user-visible content that
executes in another user's browser.

**Mitigation**:
- **React default escaping** — all user content rendered via JSX is
  HTML-escaped by default
- **No `dangerouslySetInnerHTML`** in auth surfaces (enforced by ESLint rule
  `react/no-danger` with a severity of `error` for `src/app/(staff|member|auth-public)/**`)
- **Strict CSP** in production: `script-src 'self' 'unsafe-inline'` only
  initially; tighten to nonce-based in a later iteration
- **Content-Type enforcement** — API responses are `application/json` only,
  never HTML
- **Input validation** — zod schemas on every request body; no raw
  user input flows to `innerHTML`

**Tests**:
- `tests/e2e/xss-injection.spec.ts` — attempts XSS payloads in email,
  display name, and error messages; asserts they render as plain text

### T-09. SQL Injection

**Attack**: attacker crafts a payload in a form field that breaks out of a
SQL string and executes attacker-controlled SQL.

**Mitigation**:
- **Drizzle ORM parameterised queries** exclusively — no string
  concatenation, no raw SQL except in migrations (which are reviewed)
- **ESLint rule** forbids `db.execute(sql\`...${userInput}\`)` patterns
- **Input validation** via zod before the value reaches any query

**Tests**:
- `tests/integration/auth/sql-injection.test.ts` — sends classic payloads
  (`' OR 1=1 --`, Unicode tricks, nested quotes) in email + password
  fields; asserts no rows match

### T-10. Privilege escalation via role change race

**Attack**: a manager and an admin simultaneously attempt actions that
depend on the manager's role; a race condition could allow the manager to
perform an admin action right as their role is being elevated (or vice versa).

**Mitigation**:
- **Session invalidation on role change** — all of the target's sessions
  are terminated in the same transaction as the role update; the next
  request forces re-auth and the new role is read fresh
- **SELECT FOR UPDATE lock** on the admin count during role change and
  disable (ensures last-admin check is race-free)
- **Every request re-reads the role from the session row** — no
  client-held role claim is trusted

**Tests**:
- `tests/integration/auth/last-admin-protection.test.ts` — concurrent
  attempts to demote the last admin; asserts exactly one succeeds
- `tests/integration/auth/role-change-race.test.ts` — concurrent
  "manager performs action" + "admin elevates manager"; asserts the
  manager's in-flight action is still denied

### T-11. Weak or compromised password

**Attack**: a user picks "password123" or reuses a password from a prior
leak, which the attacker finds in a credential dump.

**Mitigation**:
- **Minimum length**: 12 characters (FR-006)
- **HaveIBeenPwned k-anonymity API** on new-password flow — the client
  SHA1-hashes the password, sends the first 5 hex chars to the HIBP API,
  receives a list of suffixes, and rejects the password if its suffix is
  in the list. The full password is never transmitted.
- **Rejection is enforced server-side** — the client-side check is a UX
  convenience; the Application layer re-verifies

**Implementation note**:

```ts
// src/modules/auth/application/password-policy.ts
export async function checkPasswordPolicy(password: string): Promise<PolicyResult> {
  if (password.length < 12) return { ok: false, reason: 'too-short' };
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { 'Add-Padding': 'true' }, // HIBP privacy feature
  });
  const body = await response.text();
  const isPwned = body.split('\n').some((line) => line.split(':')[0] === suffix);
  if (isPwned) return { ok: false, reason: 'pwned' };
  return { ok: true };
}
```

HIBP failures (network, 5xx) fall back to "policy passes" — better UX than
blocking the user for an external API issue. The ops team monitors HIBP
error rates separately.

**Tests**:
- `tests/unit/auth/password-policy.test.ts` — MSW-mocks HIBP; covers
  short-password, known-pwned, clean, and HIBP-down scenarios

### T-12. Token predictability

**Attack**: attacker guesses a session ID, password reset token, or
invitation token by trying sequential values.

**Mitigation**:
- **32-byte cryptographically random** tokens (256 bits of entropy)
- Generated via `crypto.randomBytes(32).toString('hex')` — Node's CSPRNG
- Tokens are stored in columns with unique indices; collisions are
  statistically impossible at 10^50+ values

**Tests**:
- `tests/integration/auth/token-generation.test.ts` — generates 10 000 tokens;
  asserts no duplicates and entropy distribution passes a chi-square test

### T-13. Audit log tampering

**Attack**: an insider with DB access (or an attacker who compromises an app
role) tries to UPDATE or DELETE audit log rows to hide their activity.

**Mitigation**:
- **Postgres role separation** (data-model.md § 7.1): `swecham_app_rw` has
  `INSERT, SELECT` on `audit_log` only; `UPDATE` and `DELETE` are
  explicitly revoked
- **Append-only at the application layer** — no use case ever calls
  `auditRepo.update(...)` or `.delete(...)` (audit-repo.ts has no such methods)
- **Separate backup role** for retention/archive operations (out of F1)

**Tests**:
- `tests/integration/audit/append-only.test.ts` — attempts to UPDATE and
  DELETE audit rows via the `swecham_app_rw` role; asserts Postgres rejects
  with "permission denied"

### T-14. Secret leakage via logs

**Attack**: plaintext passwords, session IDs, or reset tokens end up in
application logs, telemetry, or error reports; an attacker who gains log
access gains credentials.

**Mitigation**:
- **Explicit redaction rule** in `pino` config: passwords, tokens, and
  `Authorization` headers are redacted before log emission
- **ESLint rule** forbidding `console.log(password)` or any logging call
  with an argument named `password`, `token`, `secret`, or
  `authorization`
- **CI grep check** that fails the build if a new commit introduces any
  of those patterns

**Tests**:
- `tests/unit/lib/logger-redaction.test.ts` — logs an object with sensitive
  keys; asserts the serialized output does not contain the values

### T-15. Invitation link interception

**Attack**: attacker intercepts a password reset or invitation email (e.g.,
via email forwarding, a compromised mail server, a shoulder-surf) and
redeems the token before the legitimate user.

**Mitigation**:
- **Single-use tokens** — first redeemer wins; the legitimate user sees
  "this link is no longer valid" and requests a new one
- **Short TTL** — 1 hour for reset, 7 days for invitation (trade-off: long
  enough for real-world email latency, short enough to limit exposure)
- **Audit event on successful redemption** — the legitimate user can
  detect takeover (assuming we add a "recent activity" view later; F1
  only logs)
- **Notification email** (future: F8 renewal reminders infra) — notify the
  target email when a reset completes, so the user notices if it wasn't
  them. Out of F1 scope but worth noting.

**Tests**:
- `tests/integration/auth/password-reset.test.ts` — happy path + replay
  guard (consumed token cannot be reused) + expired-token guard are all
  covered inline in this single spec. The replay and expiry cases were
  originally scoped as standalone files during planning; they were
  consolidated into `password-reset.test.ts` during implementation
  (verify gate, 2026-04-10) because the setup cost was identical and
  splitting them produced no additional coverage.
- `tests/integration/auth/account-lifecycle.test.ts` — invitation
  redemption replay (a consumed `invitations` row cannot be re-redeemed).

### T-16. Denial of Service via expensive operations

**Attack**: attacker sends a large volume of sign-in requests to exhaust
the argon2id verify capacity of the function instances.

**Mitigation**:
- **Upstream rate limit** (Upstash) — stops volume at the gateway
- **Per-IP lockout escalation** — an IP hitting the IP-level rate limit
  gets a longer lockout
- **Fail-open fallback** on Upstash outage has an **in-memory cap** of
  20 req/min per IP (critique E2) to prevent Upstash failure from
  becoming a DDoS amplifier

**Tests**:
- `tests/integration/auth/dos-rate-limit.test.ts` — simulates a burst of
  1 000 sign-in attempts from a single IP; asserts ≤ 10 reach the argon2
  path

---

## 3. Summary threats × mitigations × tests

| Threat | Mitigation | Test file |
|---|---|---|
| T-01 Credential stuffing | Lockout + rate limit + HIBP | lockout.test, rate-limit.test, signin-lockout.spec |
| T-02 Brute force single-account | argon2id + lockout | brute-force.test |
| T-03 Enumeration via sign-in | Generic 401 + dummy-hash timing | enumeration-timing.test, enumeration-message.test |
| T-04 Enumeration via reset | Always-200 + timing | forgot-password.test, reset-enumeration-timing.test |
| T-05 Session hijacking | HttpOnly + Secure + SameSite + idle + rotation | auth-cookies.test (flag contract), sign-in.test, session-revocation.spec |
| T-06 Session fixation | New session ID on sign-in/password/role change | session-rotation.test |
| T-07 CSRF | Origin header allow-list + SameSite + no state-GET | csrf.test |
| T-08 XSS | React escaping + no innerHTML + CSP + zod | xss-injection.spec |
| T-09 SQL injection | Drizzle parameterised + ESLint rule | sql-injection.test |
| T-10 Privilege escalation race | Session invalidation + SELECT FOR UPDATE | last-admin-protection.test, role-change-race.test |
| T-11 Weak password | Min 12 + HIBP check | password-policy.test |
| T-12 Token predictability | 32-byte CSPRNG | tests/integration/auth/token-generation.test.ts |
| T-13 Audit log tampering | DB role grants (INSERT only) | tests/integration/audit/append-only.test.ts |
| T-14 Secret leakage in logs | pino redaction + ESLint + CI grep | tests/unit/lib/logger-redaction.test.ts |
| T-15 Invitation link interception | Single-use + short TTL | password-reset.test (happy+replay+expired), account-lifecycle.test (invite replay) |
| T-16 DoS via argon2 | Rate limit + fail-open cap | dos-rate-limit.test |

**All 16 threats have at least one test.** The Review Gate security reviewer
MUST verify this table is complete before approving the F1 PR.

---

## 4. Out-of-scope threats (documented but deferred)

Threats acknowledged but not mitigated in F1:

| Threat | Reason | Planned for |
|---|---|---|
| Phishing of user credentials | User education, not a technical control | Future: communication templates in F8 |
| Password manager integration | Covered by standard `autocomplete` attributes | F1 inherits it |
| OAuth provider takeover | No OAuth in F1 | N/A (not planned) |
| MFA recovery | No MFA in F1 | Future phase |
| Account takeover notification email | Needs email infra maturity | F8 |
| Device fingerprinting for anomaly detection | Privacy trade-off, not worth the complexity at this scale | Never |
| Admin impersonation audit (for support) | No impersonation feature in F1 | Future phase |
| WebAuthn / passkeys | Out of scope per phases-plan.md | Future phase |

---

## 5. Review gate checklist (security reviewer)

Before approving the F1 PR, the security reviewer MUST verify:

- [ ] All 16 threats in § 2 have passing tests in the test suite
- [ ] CSRF middleware is active and has a negative test per endpoint
- [ ] Dummy-hash timing path exists in `sign-in.ts` and has a timing test
- [ ] HIBP integration is present with the k-anonymity pattern
- [ ] Audit log grants migration has been applied (not just committed)
- [ ] pino redaction is configured and tested
- [ ] No `dangerouslySetInnerHTML` in auth route trees
- [ ] No raw SQL concatenation anywhere in the repo (confirmed by grep)
- [ ] `APP_ALLOWED_ORIGINS` env var is set in Vercel production
- [ ] Session rotation on password change is verified in a test
- [ ] `last-admin-protection.test.ts` passes under concurrent load
- [ ] Rate limiter fail-open behaviour is tested with Upstash unreachable
- [ ] Error messages expose no stack traces or internal details

---

## 6. Links

- Constitution Principle I: `.specify/memory/constitution.md` § I
- Research decisions: `research.md` (§ 2 auth lib, § 3 argon2, § 4 sessions, § 4.1 CSRF, § 5 rate limit, § 6 email reliability)
- Data model: `data-model.md` (§ 7.1 audit-log grants)
- API contracts: `contracts/auth-api.md` (failure-mode tables for each endpoint)
- Plan: `plan.md` (Constitution Check Principle I)
