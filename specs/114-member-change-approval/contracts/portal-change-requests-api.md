# Contract — Member Portal change-request API

Routes under `src/app/api/portal/change-requests/**` (new) plus the narrowing of the existing
`PATCH /api/portal/profile`. Every route: Node runtime, `requireMemberContext` (member role only;
403 otherwise), tenant from `resolveTenantFromRequest`, read-only mode → 503 `read-only-mode`
(proxy), CSRF Origin allow-list (proxy). When `FEATURE_MEMBER_CHANGE_APPROVAL` is OFF every route
here returns **404** (dark ship). When the flag is ON but the tenant setting is OFF, `POST`
returns **409 `approval_not_required`** and the client falls back to the immediate path — the
portal edit form resolves the gate from `GET /api/portal/change-requests/gate` first, so this is a
race guard, not a normal path.

Error envelope (all routes): `{ error: <code>, message?: string, retryAfterSeconds?: number,
issues?: ZodIssue[] }`.

---

## `GET /api/portal/change-requests/gate`

Returns how the caller's edits will be handled.

```json
200 { "mode": "approval" | "immediate", "canProposeCompanyFields": true, "pending": { "id": "…", "submittedAt": "…", "fieldKeys": ["phone"] } | null }
```

`canProposeCompanyFields` = the caller's contact `is_primary`. `pending` = the caller's own pending
request (never another contact's).

## `POST /api/portal/change-requests` — submit (spec US1, FR-001–FR-008)

Headers: `Idempotency-Key` optional (same semantics as `/api/portal/profile`: a PRESENT malformed
key → 400; same key + same body → the stored response; same key + different body → 422
`idempotency-key-reused`). The stored response is REDUCED — `{ replay: true, outcome, request:
{ id, state, scope, submittedAt }, replaced?, staffNotified?, unchanged? }`, never a field value
(the Redis record outlives the FR-030 erasure scrub); the client reads `outcome` only.

Body (all keys optional; at least one must differ from the record):

```json
{
  "contact":  { "first_name"?: string, "last_name"?: string, "phone"?: string|null, "role_title"?: string|null },
  "company":  { "company_name"?: string, "website"?: string|null, "description"?: string|null,
                "registered_address"?: { "line1": string|null, "line2": string|null, "sub_district": string|null, "city": string|null, "province": string|null, "postal_code": string|null },
                "billing_address"?:    { "line1", "line2", "sub_district", "city", "province", "postal_code", "country": string|null } }
}
```

Rules (server): keys outside Group B → **403 `forbidden`** + `member_self_update_forbidden` audit;
`company` present while the caller is not primary → **403 `company_fields_require_primary`** +
the same audit; validation per `research.md` R14 → **422 `validation_error`** with `issues`;
nothing differs from the record and nothing is pending → **200 `{ "outcome": "nothing_to_submit" }`**
(no row); identical to the caller's pending request → **200 `{ "outcome": "already_pending",
"unchanged": false, "request": … }`**; nothing differs from the record while a DIFFERENT proposal
is pending → **200 `{ "outcome": "already_pending", "unchanged": true, "request": <the pending one> }`**
(the member cannot silently "revert" a pending proposal — withdrawing is `DELETE …/current`);
≥ 10 requests CREATED by this person in the trailing 24 h (counted from the request table,
replaced rows included — no rate-limiting service is consulted, so the cap holds with Upstash
absent) → **429 `rate_limited`** with `Retry-After` and the same `retryAfterSeconds` in the body
(when the OLDEST row leaves the window), audited `member_change_request_rate_limited
{ member_id, window_count, retry_after_seconds }`, counted on
`members_change_request_refused_total{reason=rate_limited}`, and never remembered under an
`Idempotency-Key` (transient); member archived → **403 `member_archived`**. The no-op answers
come BEFORE the cap: at the cap an identical or record-matching proposal is still
`nothing_to_submit` / `already_pending`, never 429.

Success:

```json
201 { "outcome": "submitted", "request": ChangeRequestView, "replaced": "<previous request id>" | null, "staffNotified": true | false }
```

`staffNotified=true` when at least one reviewer outbox row was queued; `false` means either the
reviewer roster was EMPTY (nobody is emailed — `members_change_request_no_reviewers_total` pages)
or the email was **coalesced** (FR-011): the replaced request's `staff_notified_at` is less than
1 h old, so no row is queued, the new row inherits that timestamp (along a chain of replacements,
so a burst of resubmits yields one email per hour) and the audit says `coalesced: true` — the
earlier email's link resolves to the person's CURRENT pending request. Side effects in ONE
transaction: previous pending (same submitter) → `withdrawn/replaced` with
`replaced_by_request_id`; insert request + fields; audit `member_change_request_submitted`; one
outbox row per active reviewer unless coalesced. A previous request that is no longer pending at
the FOR UPDATE read (decided meanwhile) is left alone: the submission is a new request with
`replaced: null` (US5 AS4).

## `GET /api/portal/change-requests` — own history (FR-029)

Query: `state?=pending|decided|withdrawn`, `cursor?`, `limit?≤50`. Returns the caller's own requests
+ the member's `company`/`mixed`-scope requests, newest first. Never another contact's
`own_contact` requests.

```json
200 { "items": ChangeRequestView[], "nextCursor": string|null }
```

## `GET /api/portal/change-requests/[id]`

404 unless the row is in the caller's FR-029 scope (never 403 — no existence leak across contacts).

## `DELETE /api/portal/change-requests/current` — withdraw (US5, FR-009)

Withdraws the caller's pending request — found by the SESSION's user id, never by a body id, so a
colleague's request can never be named; read-only mode → 503 (T116). **200** `{ "request":
ChangeRequestView }` (now `withdrawn/member`), **404 `no_pending_request`** if none — including a
decision that committed first (FR-017). Audit `member_change_request_withdrawn { member_id,
request_id, contact_id, scope, withdrawn_reason: 'member', actor_role }` on the same tx (`member_id`:
a withdrawal IS member activity). Idempotent: a second call is 404. The tenant gate is not
consulted (a pending request stays withdrawable after approval is switched off, as it stays
decidable — FR-032).

## `POST /api/portal/change-requests/[id]/acknowledge` — dismiss a shown decision (FR-010)

Only the request's submitter; request must be `decided`. Sets `outcome_acknowledged_at`
(idempotent — a second call returns the same view). **200** `{ "request": ChangeRequestView }`;
**404** outside the caller's scope; **409 `not_decided`** for pending/withdrawn. No audit event (a
UI preference, not a data change).

## `PATCH /api/portal/profile` — narrowed (R6)

Unchanged contract while the gate is `immediate`. While the gate is `approval` the accepted body is
exactly `{ "primary_contact": { "preferredLanguage": "en"|"th"|"sv" } }`; any other key → 403
`forbidden` + `member_self_update_forbidden` audit (so the existing forgery contract test gains one
case per Group B key).

---

## `ChangeRequestView`

```json
{
  "id": "uuid", "memberId": "uuid", "scope": "company"|"own_contact"|"mixed",
  "state": "pending"|"decided"|"withdrawn", "outcome": "approved"|"partially_approved"|"rejected"|null,
  "withdrawnReason": "member"|"replaced"|"erasure"|null,
  "submittedAt": "ISO-8601 UTC", "submittedBy": { "contactId": "uuid", "displayName": "…", "isMe": true },
  "decidedAt": "…"|null, "decidedBy": "organisation",           // portal never exposes the reviewer's name (FR-029)
  "decisionReason": string|null, "outcomeAcknowledgedAt": "…"|null,
  "fields": [ { "key": "phone", "target": "contact", "seen": "+66…", "proposed": "+66…",
                "affectsTaxDocuments": false, "outcome": "approved"|"rejected"|null, "appliedAt": "…"|null } ]
}
```

Address-group fields carry the whole object in `seen`/`proposed`. Timestamps are UTC ISO-8601;
the client formats (BE for `th-TH`, display-only).

## Contract tests (`tests/contract/portal/change-requests-*.test.ts`)

- flag OFF → 404 on every route; flag ON + setting OFF → `gate.mode = immediate`, POST 409.
- role pins: staff session → 403 on every route (`member-context` refusal).
- POST: each Group C key → 403 + audit; company key from a secondary → 403; each validation
  example in US1 AS4 → 422; equal payload → `nothing_to_submit` (or `already_pending` +
  `unchanged: true` while a different proposal is pending); 11th in 24 h → 429 with
  `Retry-After` + the audit row (`change-requests-replace.test.ts` over the REAL use case; the
  live-Neon twin is `tests/integration/members/change-requests-rate-cap.test.ts` with `UPSTASH_*`
  unset); a resubmit → `replaced`, coalesced within 1 h, re-notified after.
- GET history: a secondary's own-field request is absent from the primary's list and vice versa.
- DELETE: 200 then 404 (`change-requests-withdraw.test.ts`); a colleague's pending request untouched.
