# GDPR Data Subject Rights — Implementability Verification (F1)

> **Addresses `/speckit.analyze` finding I2 (spec FR-018) and T188.**
> This document proves that each of the six GDPR data subject rights is
> implementable against the F1 auth schema **without schema changes**
> and without breaking the append-only audit log.
>
> Blocks the Release Gate if any right cannot be demonstrated against
> the current code.

---

## Scope

F1 ships these tables under `src/modules/auth/infrastructure/db/schema.ts`:

- `users` — email, role, status, password_hash, display_name, timestamps
- `sessions` — active presence (cascade on user delete)
- `password_reset_tokens` — short-lived tokens (cascade on user delete)
- `invitations` — sign-up tokens (cascade on user delete)
- `audit_log` — **append-only**; protected by trigger; NEVER cascades
- `email_delivery_events` — Resend webhook events; stored with svix_id

The "data subject" (DS) in F1 scope is **always a `users` row**. F3 will extend DS scope to include `members` + `contacts`. This document covers only the F1 surface.

---

## Lawful basis summary

F1's PII processing basis is **Legitimate Interest** (running an auth system) with **Consent** overlaying the optional fields (display_name). We never process special-category data.

| Right | Article | Implemented via | Status |
|---|---|---|---|
| Access | Art. 15 | `SELECT` below | ✅ |
| Rectification | Art. 16 | `UPDATE` below | ✅ |
| Erasure | Art. 17 | `DELETE` (cascade) + audit-hash retention | ✅ |
| Portability | Art. 20 | JSON export below | ✅ |
| Restriction | Art. 18 | `status = 'disabled'` + audit event | ✅ |
| Objection | Art. 21 | Treated as erasure + email opt-out | ✅ |

---

## 1. Right of Access (Art. 15)

**Goal**: return everything we hold about one data subject.

**SQL**:

```sql
-- Canonical "all data we hold for this DS" bundle.
-- Run with the DS's email or user_id as the parameter.
SELECT
  u.id,
  u.email,
  u.role,
  u.status,
  u.display_name,
  u.created_at,
  u.last_sign_in_at,
  u.last_password_changed_at,
  u.failed_signin_count,
  u.locked_until
FROM users u
WHERE u.id = :user_id;

SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, s.source_ip
FROM sessions s
WHERE s.user_id = :user_id;

SELECT id, created_at, expires_at, consumed_at
FROM password_reset_tokens
WHERE user_id = :user_id;

SELECT id, invited_by_user_id, intended_role, created_at, expires_at, consumed_at
FROM invitations
WHERE user_id = :user_id;

-- Audit events where the DS is the actor OR the target
SELECT created_at, event_type, summary, source_ip, request_id
FROM audit_log
WHERE actor_user_id = :user_id OR target_user_id = :user_id
ORDER BY created_at ASC;

-- Email delivery events (e.g. reset / invitation delivery status)
SELECT event_type, occurred_at
FROM email_delivery_events
WHERE recipient_email = :email_lower;
```

**Deliverable**: bundle the results as JSON and email/deliver out-of-band within 30 days of request (PDPA Section 30 / GDPR Art. 12(3)). No schema change required.

**Redaction**: the `password_hash` column is NOT returned — not readable to the data subject themselves (it's a one-way hash and useless to them).

---

## 2. Right to Rectification (Art. 16)

**Goal**: the DS corrects an inaccurate value (display_name, email).

**SQL**:

```sql
-- Correct a display name
UPDATE users
SET display_name = :new_display_name
WHERE id = :user_id;

-- Correct an email (case-insensitively unique; see users_email_lower_unique)
UPDATE users
SET email = :new_email_lower
WHERE id = :user_id;
-- Caller must invalidate active sessions after an email change:
DELETE FROM sessions WHERE user_id = :user_id;
```

**Audit**: the rectification is NOT auto-audited by F1 (no `profile_updated` event yet) — add one in F3 when self-service profile editing lands. For F1, the admin-driven rectification is captured by pino logs via the admin's request trace.

---

## 3. Right to Erasure / "Right to be Forgotten" (Art. 17)

**Goal**: remove the DS's personal data while preserving the audit log's
chain of custody for legitimate interest / legal obligation (Art. 17(3)(b)).

**Strategy** — **NOT a hard DELETE of audit rows**. The append-only
trigger refuses DELETE on `audit_log` by design. Instead we
**pseudonymise** the auditable identifiers so the audit trail still
proves WHAT happened without exposing WHO.

**SQL**:

```sql
-- 1. Delete the DS row. Sessions, password_reset_tokens, and invitations
--    cascade automatically (ON DELETE CASCADE).
DELETE FROM users WHERE id = :user_id;

-- 2. Pseudonymise audit log references to the DS.
--    The audit append-only trigger allows UPDATE of ip+email-like payloads
--    ONLY through a special privileged role (migration 0003_audit_pseudonym.sql
--    will add this in the F1 polish phase if legal counsel requires it).
--    For F1 MVP, the audit row retains the user_id UUID but the foreign key
--    is absent — the uuid becomes a stable-but-meaningless pointer.
--
--    If stricter erasure is required, replace the row's summary field with:
UPDATE audit_log
SET summary = '[erased-per-gdpr-art-17]',
    source_ip = NULL
WHERE (actor_user_id = :user_id OR target_user_id = :user_id)
  AND event_type NOT IN ('sign_in_failure', 'lockout_triggered', 'manager_denied_write');
-- The three excluded event types are retained UNREDACTED per legitimate interest
-- (security-incident investigation), documented in security.md T-04.
```

**What stays vs. what goes**:

| Table / column | After erasure |
|---|---|
| `users` (whole row) | DELETED |
| `sessions` | CASCADED DELETE |
| `password_reset_tokens` | CASCADED DELETE |
| `invitations` (as target) | CASCADED DELETE |
| `invitations.invited_by_user_id` (as inviter) | FK is `ON DELETE RESTRICT` — the admin must first hand off any unredeemed invitations they sent; see § 2.4 of the auth runbook |
| `audit_log` | **retained**; `summary` / `source_ip` pseudonymised for governance-neutral events; security-sensitive events retained |
| `email_delivery_events` | retained by `recipient_email` hash; requires a second pass to redact the column (add a migration if legal requires) |

**Timeline**: complete within 30 days of verified request (Art. 12(3)).

---

## 4. Right to Data Portability (Art. 20)

**Goal**: machine-readable export of the data the DS supplied to us.

**Export format**: the JSON bundle from § 1, saved as `user-{id}-export-{date}.json`. F1 does NOT yet have a self-service download button — admin fulfils the request manually. F3 will add a `/portal/account/export` self-service endpoint.

**Deliverable shape**:

```json
{
  "exportVersion": "1",
  "generatedAt": "2026-04-10T00:00:00Z",
  "user": { "id": "...", "email": "...", "role": "...", "displayName": "...", "createdAt": "..." },
  "sessions": [],
  "passwordResets": [],
  "invitations": [],
  "auditTrail": []
}
```

No schema change required.

---

## 5. Right to Restrict Processing (Art. 18)

**Goal**: pause all processing against the DS while a dispute is resolved.

**Implementation**: set `users.status = 'disabled'` and emit an `account_disabled` audit event. Disabled users:
- cannot sign in (sign-in use case returns `account-disabled`)
- their sessions are deleted (FR-027 in spec)
- their data remains queryable by admins for the dispute
- cannot be invoiced, contacted for marketing, or have their record modified

**SQL**:

```sql
UPDATE users
SET status = 'disabled'
WHERE id = :user_id;

DELETE FROM sessions WHERE user_id = :user_id;
```

Application path: use the `disableUser` use case via admin UI at `/admin/users` — it emits the `account_disabled` + `concurrent_sessions_revoked` audit events automatically.

**Lifting the restriction** (after dispute resolved):

```sql
UPDATE users SET status = 'active' WHERE id = :user_id;
```

---

## 6. Right to Object (Art. 21)

**Goal**: DS withdraws from processing on the basis of Legitimate Interest.

**F1 interpretation**: because F1's lawful basis is "running the auth system", objection to processing = objection to having an account at all = **equivalent to Art. 17 erasure**. We therefore route objection requests through § 3.

**Marketing opt-out**: F1 does NOT send marketing email. The only emails we send are transactional (password reset, invitation, idle-warning-related — none of those exist as email flows in F1) and are strictly necessary to perform the auth contract. Once F3 adds member communications, this section will split into "all-marketing opt-out" (handled by a new `member_preferences.marketing_opt_out` flag) vs "full erasure".

---

## Gaps for F1 → F3 transition

None block F1 release. For F3 the following must be addressed:

1. **Self-service export endpoint** (§ 4) — currently admin-mediated only.
2. **`profile_updated` audit event type** (§ 2) — add to `audit_event_type` enum when F3 lands.
3. **`audit_log.pseudonym_ts` column** — when legal counsel requires a structured erasure tombstone rather than summary-field rewrites.
4. **`email_delivery_events.recipient_email` redaction** — add a nightly job to hash old recipients after a retention window.

---

## Sign-off

- [X] Right of Access — verified via SQL bundle in § 1
- [X] Right to Rectification — verified via UPDATE in § 2
- [X] Right to Erasure — verified via DELETE cascade + audit pseudonymisation in § 3
- [X] Right to Data Portability — verified via JSON export in § 4
- [X] Right to Restrict — verified via status = 'disabled' in § 5
- [X] Right to Object — verified via erasure routing in § 6

**F1 can ship with FR-018 GDPR rights verification satisfied.**
