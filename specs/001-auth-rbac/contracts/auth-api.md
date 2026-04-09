# F1 Auth API Contracts

**Feature**: 001-auth-rbac
**Date**: 2026-04-09
**Purpose**: HTTP contracts for every authentication endpoint exposed by F1.
Each contract is source-of-truth for the corresponding contract test in
`tests/contract/`.

**Conventions**:

- All endpoints are HTTPS only (enforced by Vercel + HSTS).
- All endpoints accept `Content-Type: application/json` on request bodies and
  return `application/json` on response bodies.
- Error responses use RFC 7807 *Problem Details for HTTP APIs*:

  ```json
  {
    "type": "https://api.swecham.example/errors/<slug>",
    "title": "Human-readable short title",
    "status": 400,
    "detail": "Optional longer explanation, safe for the user to see",
    "instance": "x-request-id correlation value"
  }
  ```

- Locale for error messages is negotiated via the `Accept-Language` header
  (EN / TH / SV). Server falls back to EN if unsupported.
- Rate-limit headers on every endpoint:
  - `RateLimit-Limit`
  - `RateLimit-Remaining`
  - `RateLimit-Reset` (seconds)
- Security headers (set by middleware, not re-documented per endpoint):
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Content-Security-Policy: default-src 'self'; ...` (exact policy TBD in implementation)
  - `Referrer-Policy: strict-origin-when-cross-origin`

---

## 1. `POST /api/auth/sign-in`

Sign a user into the appropriate portal.

### Request

```http
POST /api/auth/sign-in HTTP/1.1
Host: app.swecham.example
Content-Type: application/json
Accept-Language: en
x-request-id: 0192f0a1-...

{
  "email": "jane@example.com",
  "password": "correct horse battery staple",
  "portal": "staff"
}
```

**Body schema** (zod):

```ts
import { z } from 'zod';

export const SignInRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1000),
  portal: z.enum(['staff', 'member']),
});
```

### Success response

```http
HTTP/1.1 200 OK
Set-Cookie: swecham_session=<64-hex>; HttpOnly; Secure; SameSite=Lax; Path=/
Content-Type: application/json

{
  "user": {
    "id": "01934f...",
    "email": "jane@example.com",
    "role": "admin",
    "displayName": "Jane"
  },
  "redirectTo": "/admin"
}
```

### Failure responses

| Status | `type` slug | When | Notes |
|---|---|---|---|
| 400 | `invalid-input` | Body fails zod schema | Only field names leaked, never values |
| 401 | `invalid-credentials` | Email not found, wrong password, wrong portal for role | Same message in all 3 cases to prevent enumeration (FR-016) |
| 403 | `account-disabled` | Account status is `disabled` | Reveals that the account exists, but only to someone who has the correct credentials — acceptable trade-off |
| 403 | `account-locked` | `locked_until > now()` due to FR-013 lockout | Response includes `Retry-After: <seconds>` header |
| 403 | `account-pending` | Status is `pending` — user hasn't redeemed invitation yet | Tell them to check their invitation email |
| 429 | `rate-limited` | Exceeded rate limit per email or per IP | `Retry-After` header set |

### Audit events emitted

- On success: `sign_in_success`
- On invalid credentials: `sign_in_failure` (actor = `anonymous` if email unknown; otherwise actor = the user)
- On account locked: `sign_in_failure`
- When the lockout threshold is crossed **during** this request: an extra
  `lockout_triggered` event is appended in the same transaction as the
  `sign_in_failure`

### Contract test file

`tests/contract/sign-in.test.ts` — MUST cover all listed failure modes + the
rate-limit response shape.

---

## 2. `POST /api/auth/sign-out`

End the current session.

### Request

```http
POST /api/auth/sign-out HTTP/1.1
Cookie: swecham_session=<64-hex>
```

No body.

### Success response

```http
HTTP/1.1 200 OK
Set-Cookie: swecham_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0
Content-Type: application/json

{ "ok": true }
```

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 401 | `no-session` | No cookie or invalid session ID |

`sign-out` is idempotent — calling it without a session still returns 200 with
`{ok: true}` (no-op), so that sign-out links never "fail" for the user. The
401 failure is for API callers that want strict correctness.

### Audit events

- `sign_out` on valid session ended

---

## 3. `POST /api/auth/forgot-password`

Request a password reset link.

### Request

```http
POST /api/auth/forgot-password HTTP/1.1
Content-Type: application/json

{ "email": "jane@example.com" }
```

### Response (always 200 for enumeration safety)

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "message": "If an account exists for that email, a reset link has been sent." }
```

- **Always** returns 200, regardless of whether the email is registered
  (FR-016 enumeration protection).
- If the email IS registered and the account is `active`, a reset token is
  created + emailed via Resend.
- If the email is not registered, nothing happens (but response is the same).
- If the account is `pending` or `disabled`, no email is sent (same response).

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 400 | `invalid-input` | Body fails zod schema |
| 429 | `rate-limited` | 3/hour per email or 10/hour per IP |

### Audit events

- `password_reset_requested` — ONLY when the account exists and is active
  (not emitted for unknown emails to avoid log-side enumeration)

---

## 4. `POST /api/auth/reset-password`

Complete a password reset using a token.

### Request

```http
POST /api/auth/reset-password HTTP/1.1
Content-Type: application/json

{
  "token": "<64-hex>",
  "newPassword": "a fresh new long passphrase"
}
```

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "ok": true, "signInUrl": "/admin/sign-in" }
```

- All existing sessions for this user are invalidated in the same transaction
  (FR-008).
- `concurrent_sessions_revoked` event is written if the user had sessions.

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 400 | `invalid-input` | Body fails zod schema |
| 400 | `weak-password` | Password policy failure — detail field specifies which rule |
| 410 | `token-expired` | Token past `expires_at` |
| 410 | `token-used` | Token already consumed |
| 404 | `token-not-found` | Token does not exist |
| 429 | `rate-limited` | Too many attempts |

All three 410/404 cases use the **same** public-facing message ("this link is
no longer valid") to avoid leaking which failure occurred. The `type` slug
differs only in internal logs.

### Audit events

- On success: `password_reset_completed`, then `concurrent_sessions_revoked`
  if any were killed
- On expired/used token: `invitation_redemption_failed` is NOT fired (that's
  for invitations); no specific audit event for failed reset token use.
  (Rate-limit events are captured by the rate limiter itself.)

---

## 5. `POST /api/auth/change-password`

Change the current user's password while they remain signed in.

### Request

```http
POST /api/auth/change-password HTTP/1.1
Cookie: swecham_session=<64-hex>
Content-Type: application/json

{
  "currentPassword": "old passphrase",
  "newPassword": "new longer passphrase"
}
```

### Success response

```http
HTTP/1.1 200 OK
Set-Cookie: swecham_session=<NEW 64-hex>; ...   (new session issued for continuity)
Content-Type: application/json

{ "ok": true }
```

- Every **OTHER** session for this user is invalidated.
- The **current** session is rotated (new ID issued, old deleted) to limit the
  damage if the old ID had leaked.

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 400 | `invalid-input` | Body fails zod schema |
| 401 | `no-session` | Not signed in |
| 403 | `wrong-current-password` | Current password verification failed |
| 400 | `weak-password` | New password fails policy |
| 400 | `same-password` | New password equals current |
| 429 | `rate-limited` | 5 wrong-current attempts / 15 min per user |

### Audit events

- On success: `password_changed`, then `concurrent_sessions_revoked` if any were killed

---

## 6. `POST /api/auth/invite`

Admin creates a new staff or member account (invitation-based).

### Request

```http
POST /api/auth/invite HTTP/1.1
Cookie: swecham_session=<admin's session>
Content-Type: application/json

{
  "email": "new.staff@swecham.example",
  "role": "manager",
  "displayName": "Lars Nilsson"
}
```

**Authorisation**: the session owner MUST have `role === 'admin'`. A non-admin
caller gets 403 + `manager_denied_write` audit event if the caller is a manager.

### Success response

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "user": {
    "id": "01934f...",
    "email": "new.staff@swecham.example",
    "role": "manager",
    "status": "pending"
  }
}
```

An invitation email is dispatched asynchronously via Resend. The response does
not wait for email delivery; delivery failure is captured by Resend webhooks
(out of F1 scope — operational runbook concern).

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 400 | `invalid-input` | Body fails zod schema |
| 401 | `no-session` | Not signed in |
| 403 | `forbidden` | Caller is not admin (manager_denied_write audit event emitted if caller is manager) |
| 409 | `email-taken` | Email is already in use (including pending accounts) |

### Audit events

- On success: `account_created` (actor = calling admin, target = new user)
- On 403 with manager caller: `manager_denied_write`

---

## 7. `POST /api/auth/redeem-invite`

Invitee sets their initial password and activates their account.

### Request

```http
POST /api/auth/redeem-invite HTTP/1.1
Content-Type: application/json

{
  "token": "<64-hex>",
  "password": "a strong initial passphrase",
  "displayName": "Lars Nilsson"
}
```

### Success response

```http
HTTP/1.1 200 OK
Set-Cookie: swecham_session=<new 64-hex>; ...   (auto sign-in after redemption)
Content-Type: application/json

{
  "user": {
    "id": "01934f...",
    "email": "new.staff@swecham.example",
    "role": "manager",
    "status": "active"
  },
  "redirectTo": "/admin"
}
```

The user transitions from `pending` to `active`; password is hashed and
stored; an initial session is created so the user lands signed in.

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 400 | `invalid-input` | Body fails zod schema |
| 400 | `weak-password` | Password policy failure |
| 410 | `token-expired` | Token past `expires_at` |
| 410 | `token-used` | Token already consumed |
| 404 | `token-not-found` | Token does not exist |
| 429 | `rate-limited` | Too many attempts |

### Audit events

- On success: `account_created` has already been emitted at invitation time;
  no new event at redemption other than `sign_in_success` for the auto sign-in
- On 410/404: `invitation_redemption_failed`

---

## 8. `POST /api/auth/users/{id}/disable` (admin-only)

Disable an active account.

### Request

```http
POST /api/auth/users/<user-id>/disable HTTP/1.1
Cookie: swecham_session=<admin>
```

No body.

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "ok": true }
```

- All active sessions for the target user are terminated in the same transaction.

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 401 | `no-session` | Not signed in |
| 403 | `forbidden` | Caller is not admin |
| 404 | `not-found` | Target user ID does not exist |
| 409 | `last-admin-protection` | Target is the last active admin AND caller is target (FR-011) |

### Audit events

- On success: `account_disabled`, then `session_forcibly_ended` for each
  killed session (batched into a single `concurrent_sessions_revoked` event)

---

## 9. `POST /api/auth/users/{id}/enable` (admin-only)

Re-enable a disabled account.

### Request / success / failure

Symmetric to `/disable` but transitions `disabled → active`. No session killing
required (there are none for a disabled account).

### Audit events

- On success: `account_reenabled`

---

## 10. `POST /api/auth/users/{id}/role` (admin-only)

Change a user's role.

### Request

```http
POST /api/auth/users/<user-id>/role HTTP/1.1
Cookie: swecham_session=<admin>
Content-Type: application/json

{ "newRole": "admin" }
```

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "ok": true }
```

- All active sessions for the target user are terminated so the new role
  takes effect cleanly.

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 401 | `no-session` | Not signed in |
| 403 | `forbidden` | Caller is not admin |
| 404 | `not-found` | Target does not exist |
| 409 | `last-admin-protection` | Demoting the last active admin (FR-011) |
| 400 | `invalid-role` | `newRole` not in enum |
| 400 | `role-portal-mismatch` | Changing between staff role (admin/manager) and member role is forbidden in F1 (out of scope; requires separate account per Q2) |

### Audit events

- On success: `role_changed`, then `concurrent_sessions_revoked`
- On 400 `role-portal-mismatch`: no audit event; this is a validation error

---

## 11. `POST /api/auth/heartbeat`

Refresh the session's `last_seen_at` without performing any other action.
Used by the idle-warning "Stay signed in" button (FR-022, ux-standards § 8.2).

### Request

```http
POST /api/auth/heartbeat HTTP/1.1
Cookie: swecham_session=<64-hex>
```

No body.

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "ok": true, "lastSeenAt": "2026-04-09T10:45:00Z" }
```

- Atomic update of `sessions.last_seen_at = now()`.
- Does NOT extend the absolute `expires_at` — only the sliding idle clock.
- Idempotent — repeated calls are safe.

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 401 | `no-session` | No cookie, invalid, or session already expired (idle or absolute) |
| 429 | `rate-limited` | More than 60 heartbeats per minute per session (defends against a misbehaving client) |

### Audit events

- **None.** Heartbeats are routine and would flood the audit log — per
  spec § User Story 7, idle/absolute timeout expirations are explicitly
  NOT audited, and routine heartbeats share that rationale.

### Contract test file

`tests/contract/heartbeat.test.ts` — MUST verify idempotency, rate-limit,
401 on expired, and that `last_seen_at` advances while `expires_at` does not.

---

## 12. `POST /api/webhooks/resend`

Receive delivery-event webhooks from Resend (email provider). Used to track
whether transactional emails were actually delivered to the recipient's
mailbox, complementing the API-level retry in research.md § 6.1.

### Request

```http
POST /api/webhooks/resend HTTP/1.1
Content-Type: application/json
svix-id: msg_...
svix-timestamp: 1712664195
svix-signature: v1,whsec_...

{
  "type": "email.delivered",
  "created_at": "2026-04-09T10:23:15.123Z",
  "data": {
    "email_id": "re_msg_01934f...",
    "to": ["jane@example.com"],
    "subject": "Reset your SweCham password"
  }
}
```

**Signature verification**: the handler MUST verify the Svix signature
header using `RESEND_WEBHOOK_SIGNING_SECRET` (env var). Requests with
missing or invalid signatures return 401 `invalid-webhook-signature`.

**Supported event types**:
- `email.sent` — Resend has accepted the message for relay
- `email.delivered` — the recipient's mailbox accepted the message
- `email.delivery_delayed` — transient failure, Resend will retry
- `email.bounced` — permanent failure, no retry
- `email.complained` — recipient marked the message as spam
- `email.opened`, `email.clicked` — informational (not mission-critical)

### Success response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "ok": true }
```

- The handler writes an `email_delivery_events` row with the event type,
  timestamp, message ID, and recipient email.
- On `email.bounced` or `email.complained`, it emits a pino warning with
  the message ID and recipient email for operational follow-up.
- On `email.bounced` where the bounce is related to a password-reset or
  invitation token, the tracking table records the link so the
  user-facing waiting screen can display an inline warning (spec FR-025).

### Failure responses

| Status | `type` slug | When |
|---|---|---|
| 401 | `invalid-webhook-signature` | Missing or bad Svix signature |
| 400 | `invalid-input` | Body fails zod schema |
| 429 | `rate-limited` | Absurd volume (Resend itself shouldn't hit this) |

### Audit events

- **None directly** — webhook events are operational signals, not auth
  events. They are recorded in the `email_delivery_events` tracking table
  instead, which is separate from the append-only auth audit log.

### Idempotency

The webhook handler is idempotent — Resend may resend the same event if
it does not receive a 200 within its timeout. Duplicate events are
detected via `svix-id` header and de-duplicated at the handler level
(in-memory LRU cache of recent message IDs is sufficient for F1).

### Contract test file

`tests/contract/resend-webhook.test.ts` — MUST verify signature
verification (valid, invalid, missing), all 6 event types, idempotent
handling of duplicate events, and that `email.bounced` triggers the
expected pino warning.

---

## Cross-cutting: request/response types as TypeScript

All the above are mirrored in `src/modules/auth/application/contracts.ts` as
zod schemas so request parsing and response construction are type-safe end to
end. Contract tests import those schemas and assert exact shape + status.

## Contract test inventory

Each of the 10 endpoints has a one-file-per-endpoint test under
`tests/contract/`. The Constitution Principle II gate requires each of these
files to be written and FAIL before the corresponding use case is
implemented.

| Endpoint | Test file |
|---|---|
| `POST /api/auth/sign-in` | `tests/contract/sign-in.test.ts` |
| `POST /api/auth/sign-out` | `tests/contract/sign-out.test.ts` |
| `POST /api/auth/forgot-password` | `tests/contract/forgot-password.test.ts` |
| `POST /api/auth/reset-password` | `tests/contract/reset-password.test.ts` |
| `POST /api/auth/change-password` | `tests/contract/change-password.test.ts` |
| `POST /api/auth/invite` | `tests/contract/invite.test.ts` |
| `POST /api/auth/redeem-invite` | `tests/contract/redeem-invite.test.ts` |
| `POST /api/auth/users/{id}/disable` | `tests/contract/disable-user.test.ts` |
| `POST /api/auth/users/{id}/enable` | `tests/contract/enable-user.test.ts` |
| `POST /api/auth/users/{id}/role` | `tests/contract/change-role.test.ts` |
| `POST /api/auth/heartbeat` | `tests/contract/heartbeat.test.ts` |
| `POST /api/webhooks/resend` | `tests/contract/resend-webhook.test.ts` |
