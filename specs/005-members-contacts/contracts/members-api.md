# API Contracts — F3 Members & Contacts

**Branch**: `005-members-contacts` | **Date**: 2026-04-15

All endpoints require an authenticated session (F1). Authorisation enforced via the F1 `rbac-guard.ts` extended with `members:*` + `contacts:*` resource families (research § 3). All mutation endpoints require an `Idempotency-Key` header (UUID v7) per the F1+F2 pattern. All responses are JSON; errors use the F1 `Result<T, E>` shape with HTTP status codes per the table below.

Tenant context is resolved server-side from the session — clients never send a `tenant_id`. Cross-tenant probes return **404 not_found** (never 403/401) per FR-022.

---

## Common error shape

```json
{
  "error": {
    "code": "validation_error" | "not_found" | "forbidden" | "conflict" | "rate_limited" | "read_only_mode" | "internal",
    "message": "Localized message",
    "details": [{ "field": "...", "issue": "..." }]
  }
}
```

| HTTP | When |
|---|---|
| `400 validation_error` | zod schema rejection |
| `403 forbidden` | RBAC failure or member self-service forged payload (FR-014) |
| `404 not_found` | Resource missing OR cross-tenant probe (FR-022) |
| `409 conflict` | Idempotency-Key reuse with different body, partial-index race |
| `429 rate_limited` | F1 rate limiter |
| `503 read_only_mode` | Emergency `READ_ONLY_MODE=true` flag set |
| `500 internal` | Uncaught error (rare; logged) |

---

## Endpoints

### 1. `GET /api/members`

**Description**: Directory list with filters (US2).

**Query params**:
- `q`: string (substring search across company_name + primary contact name + primary contact email) — case-insensitive
- `plan_tier`: enum
- `plan_year`: int
- `status`: `active` | `inactive` | `archived` (default: `active,inactive`; `archived` opt-in via `?show_archived=1`)
- `country`: ISO alpha-2
- `partnership_tier`: enum
- `at_risk`: boolean (placeholder, no-op until F8)
- `cursor`: opaque pagination cursor
- `limit`: int 1..100 (default 50)

**RBAC**: `admin` + `manager` (read).

**Response 200**:
```json
{
  "items": [
    { "member_id": "...", "company_name": "...", "country": "TH",
      "plan_id": "...", "plan_tier": "Premium Corporate", "plan_year": 2026,
      "status": "active", "member_risk_flag": null,
      "primary_contact": { "contact_id": "...", "first_name": "...", "last_name": "...", "email": "..." },
      "last_activity_at": "2026-03-15T10:00:00Z" }
  ],
  "next_cursor": "..."
}
```

---

### 2. `POST /api/members`

**Description**: Create new member with primary contact (US1).

**Headers**: `Idempotency-Key: <uuid>`

**Body**:
```json
{
  "company_name": "Fogmaker International AB",
  "legal_entity_type": "AB",
  "country": "SE",
  "tax_id": "SE5560000000",
  "website": "https://...",
  "description": "...",
  "founded_year": 2008,
  "turnover_thb": 120000000,
  "plan_id": "...",
  "plan_year": 2026,
  "registration_date": "2026-04-15",
  "primary_contact": {
    "first_name": "Anna",
    "last_name": "Andersson",
    "email": "anna@fogmaker.se",
    "phone": "+46701234567",
    "role_title": "CEO",
    "preferred_language": "sv",
    "date_of_birth": null
  },
  "override_reason_code": null,
  "override_reason_note": null
}
```

**RBAC**: `admin` only.

**Validation**:
- Plan-tier-aware `tax_id` requirement (FR-009a).
- Turnover band check (FR-006) — if mismatched, `400 validation_error` with code `turnover_warning`; client must retry with `override_reason_code` populated.
- Start-up duration check (FR-007) — same pattern.
- Thai Alumni age check (FR-008) — same pattern, requires `date_of_birth`.

**Response 201**:
```json
{ "member_id": "...", "primary_contact_id": "..." }
```

**Audit**: `member_created` + `contact_created`.

---

### 3. `GET /api/members/[memberId]`

**Description**: Member detail (US2 deep link).

**Query params**: `?include=date_of_birth` — admin-only opt-in.

**RBAC**: `admin` + `manager` (full read), `member` (only own member; redacted notes + override reasons).

**Response 200**: Full member + nested contacts array.

**Cross-tenant**: returns 404 + emits `member_cross_tenant_probe`.

---

### 4. `PATCH /api/members/[memberId]`

**Description**: Update member fields, plan, or trigger bundle change (US3).

**Headers**: `Idempotency-Key: <uuid>`

**Body**: partial `Member` update; for plan change include `new_plan_id` + optional `override_reason_*`.

**RBAC**: `admin` only.

**Special behavior — bundle change** (FR-010): when the new plan is a Partnership tier and `includes_corporate_plan_id` differs from the current bundle, the server requires a `confirm_bundle_change: true` flag in the body — clients first call endpoint #11 to fetch the affected count, show the dialog, and re-submit on confirm. Without the flag the server returns `409 conflict` with code `bundle_change_requires_confirmation`.

**Response 200**: updated member.

**Audit**: `member_updated` and/or `member_plan_changed` and/or `plan_bundle_changed`.

---

### 5. `POST /api/members/[memberId]/archive`

**Description**: Soft-delete member (US7).

**Headers**: `Idempotency-Key`

**Body**: `{ "reason": "..." }` (optional, ≤ 500 chars)

**RBAC**: `admin` only.

**Validation**:
- `400 invalid_body` when `reason` exceeds 500 chars.
- `409 conflict` with code `state_error` (+ `details.code = state.cannot_archive_already_archived`) when the target member is already archived.

**Response 200**: full member shape with `status = "archived"` + `archived_at` populated.

**Cascades** (all inside one tenant-scoped tx):
- Every active contact's linked F1 user → all sessions revoked via `SessionRevocationPort`.
- Pending (unredeemed + unexpired) F1 invitations for those users → soft-consumed (`consumed_at = NOW()`) so existing invite links can no longer be redeemed.

**Audit**: one `member_archived` with payload `{ member_id, reason?, cascaded_user_ids, sessions_revoked_total, invitations_revoked_count }` + one `user_sessions_revoked` per linked user whose sessions were killed.

---

### 6. `POST /api/members/[memberId]/undelete`

**Description**: Restore archived member within 90-day window (US7).

**Headers**: `Idempotency-Key`

**RBAC**: `admin` only.

**Validation**:
- `403 forbidden` with code `archive_window_expired` if `archived_at < NOW() - 90 days`.
- `409 conflict` with code `state_error` (+ `details.code = state.undelete_only_from_archived`) when the target member is NOT in `archived` status — prevents accidental state flips on already-active members.

**Response 200**: `{ "status": "active" }`.

**Audit**: `member_undeleted`.

---

### 7. `POST /api/members/[memberId]/contacts`

**Description**: Add contact to member (US3).

**Headers**: `Idempotency-Key`

**Body**: `Contact` shape minus IDs and `linked_user_id`.

**RBAC**: `admin` only.

**Response 201**: `{ "contact_id": "..." }`.

**Audit**: `contact_created`.

---

### 8. `PATCH /api/members/[memberId]/contacts/[contactId]`

**Description**: Update contact (US3). Email change triggers FR-012a atomic transaction.

**Headers**: `Idempotency-Key`

**Body**: partial Contact.

**RBAC**: `admin` only (member self-service uses endpoint #10).

**Special behavior — email change**: if `email` differs from the stored value AND the contact has `linked_user_id`, the server runs the FR-012a transaction (revoke sessions, update F1 user email, set `email_verified_at = NULL`, enqueue verification token via outbox with 5-minute delayed activation, AND enqueue dual-channel revert-token notification to the OLD email via outbox). The response includes `verification_email_enqueued: true` and `revert_notification_enqueued: true`. On later outbox permanent failure, both flags become `false` on subsequent GET — admin triggers recovery via endpoint #15.

**Response 200**: updated contact.

**Audit**: `contact_updated`, plus (on email change) `member_contact_email_changed` + `user_sessions_revoked` + `email_verification_sent`.

---

### 9. `POST /api/members/[memberId]/contacts/[contactId]/promote-primary`

**Description**: Make this contact the primary; auto-demotes the previous primary (US3 AS2).

**Headers**: `Idempotency-Key`

**RBAC**: `admin` only.

**Response 200**: `{ "primary_contact_id": "..." }`.

**Conflict handling**: concurrent promotions resolved by the partial-index unique constraint; loser receives `409 conflict` with code `primary_contact_race`.

**Audit**: `member_primary_contact_changed`.

---

### 10. `POST /api/members/bulk`

**Description**: Bulk action on selected member IDs (US4).

**Headers**: `Idempotency-Key`

**Body**:
```json
{
  "action": "change_plan" | "archive" | "send_portal_invite",
  "member_ids": ["..."],            // ≤ 100 enforced server-side (FR-019a)
  "params": {                       // shape depends on action
    "new_plan_id": "...",
    "override_reason_code": null,
    "override_reason_note": null
  }
}
```

**RBAC**: `admin` only.

**Rate limit**: `≤ 10 bulk operations per 10-minute window per (tenant_id, actor_user_id)` (FR-019b). Exceeding returns `429 rate_limited` with code `bulk_rate_limit_exceeded` + emits `bulk_action_rate_limit_exceeded` audit event.

**Validation**:
- `member_ids.length ≤ 100` — server returns `400 validation_error` with code `bulk_cap_exceeded` if violated.
- All members must belong to current tenant (RLS); cross-tenant IDs silently filtered out via RLS, then if any IDs are missing the server returns `404 not_found` for the entire request (all-or-nothing per FR-019).

**Response 200**:

`change_plan` / `archive` (atomic all-or-nothing):
```json
{ "updated_count": 100, "audit_event_count": 100 }
```

`send_portal_invite` (best-effort per member — partial success is still 200;
the invite is queued per member, so it cannot be rolled back as a batch):
```json
{
  "invited": [{ "member_id": "...", "contact_id": "...", "user_id": "...", "email": "..." }],
  "resent":  [{ "member_id": "...", "contact_id": "..." }],
  "skipped": [{ "member_id": "...", "reason": "already_linked" | "no_email" | "no_invitable_contact" | "member_archived" | "member_not_found" }],
  "failed":  [{ "member_id": "...", "code": "invalid_email" | "email_taken" | "link_failed" | "server_error" }],
  "counts":  { "invited": 0, "resent": 0, "skipped": 0, "failed": 0 }
}
```
`resent` = a member whose primary contact was already linked but whose portal
invitation had expired unaccepted; a fresh token was minted via the re-send path
(057-members-portal-status). `already_linked` in `skipped` therefore now means an
*active* portal user (nothing to do), not an expired one.

**Audit**: per-member event of the matching type (e.g., 100 × `member_plan_changed`;
`send_portal_invite` records `account_created` per new invite and
`member_portal_invite_queued` per re-send).

---

### 11. `GET /api/plans/[year]/[planId]/affected-members`

**Description**: Real-count fetch for the bundle-change warning dialog (FR-010, F2 D1 carry-over). **Routes under `/api/plans/`** for URL coherence; **handler imports use case from `@/modules/members`** (Principle III boundary clarity per plan § Project Structure).

**Query params**: `?new_includes_corporate_plan_id=...` (optional — to compute warning text)

**RBAC**: `admin` only.

**Response 200**:
```json
{
  "current_count": 3,
  "old_includes_corporate_plan_id": "uuid-of-premium-corporate",
  "new_includes_corporate_plan_id": "uuid-of-large-corporate"
}
```

**Performance target**: p95 < 200 ms on plans with ≤ 500 members (SC-008).

---

## Member self-service endpoints (`/api/portal/*`)

### 12. `GET /api/portal/profile`

**Description**: Read own member + own contact (US5).

**RBAC**: `member` only; resolver returns the member tied to `session.member_id`.

**Response 200**: same shape as endpoint #3 but redacted fields:
- `notes`: omitted
- override reason fields: omitted from any nested timeline entries
- `date_of_birth`: included (own data)

---

### 13. `PATCH /api/portal/profile`

**Description**: Edit whitelisted fields only (FR-014, US5).

**Headers**: `Idempotency-Key`

**Body** (only these fields allowed; any other field → `403 forbidden` + `member_self_update_forbidden` audit):
```json
{
  "primary_contact": {
    "first_name": "...",
    "last_name": "...",
    "phone": "...",
    "preferred_language": "..."
  },
  "website": "...",
  "description": "..."
}
```

**Response 200**: updated profile.

**Audit**: `member_self_updated` (or `member_self_update_forbidden` on rejection).

---

### 14. `POST /api/portal/contacts/invite`

**Description**: Member invites a colleague as secondary contact (US5 AS4).

**Headers**: `Idempotency-Key`

**Body**: `{ "first_name", "last_name", "email", "role_title", "preferred_language" }`

**RBAC**: `member` (primary contact only — enforced via `is_primary` check).

**Response 201**: `{ "invitation_id": "...", "expires_at": "..." }` (uses F1 invitation flow).

**Audit**: `contact_created` (with `linked_user_id = NULL` until accepted) + F1 `invitation_issued`.

---

### 15. `POST /api/members/[memberId]/contacts/[contactId]/resend-verification`

**Description**: Admin recovery action when the FR-012a verification email permanently failed in the outbox (FR-012c).

**Headers**: `Idempotency-Key`

**RBAC**: `admin` only.

**Response 200**: `{ "verification_email_enqueued": true, "new_token_expires_at": "..." }`.

**Audit**: `email_verification_resent`.

---

### 16. `POST /api/auth/email-change/revert/[token]` (public — unauthenticated)

**Description**: Old-email revert-token handler (FR-012b). The OLD-email recipient clicks the 48-hour single-use token from the dual-channel notification email and lands here to revert the change.

**Headers**: no session required; token in URL is the auth.

**Body**: `{}` (token alone is sufficient).

**Validation**:
- Token valid + unexpired + unredeemed.
- Original change was within 48 hours.

**Side effects** (single transaction):
- Restore old email on contact + linked F1 user.
- Invalidate the new-email verification token.
- Flag the linked F1 user `requires_password_reset = TRUE`.
- Invalidate any active sessions (redundant — they were already revoked on FR-012a).

**Response 200**: HTML page confirming revert + "Set a new password" CTA → `/forgot-password` with email prefilled.

**Audit**: `member_email_change_reverted` (high severity).

**Rate limit**: 5 attempts per token per 10 minutes (prevents brute-force of token space).

---

## Idempotency-Key conventions

- Required on every POST / PATCH / DELETE.
- UUID v7 (time-ordered) recommended; any UUID v4 also accepted.
- Server stores `(tenant_id, idempotency_key, request_hash, response, expires_at = NOW() + 24h)`.
- Repeat key + same hash → returns the original response (idempotent retry).
- Repeat key + different hash → `409 conflict` with code `idempotency_key_mismatch`.
- TTL: 24 h.
