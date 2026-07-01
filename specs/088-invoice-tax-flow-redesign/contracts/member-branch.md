# Contract — Member Head Office / Branch (§86/4 buyer particular)

**Feature**: `088-invoice-tax-flow-redesign` · **Surface**: `PATCH /api/members/[memberId]`
(the plain field-update arm — NOT the `new_plan_id` change-plan arm)
**Use-case**: `updateMember` (`src/modules/members/application/use-cases/update-member.ts`)
**Route handler**: `src/app/api/members/[memberId]/route.ts`
**Covers**: US3 (AS1, AS2), FR-008

---

## Purpose

Add the §86/4 **Head Office / Branch** buyer particular to the F3 member record so it can be
pinned into the immutable buyer identity snapshot at invoice-issue time. New columns on `members`:

- `is_head_office boolean NOT NULL DEFAULT true`
- `branch_code char(5)` (nullable; RD 5-digit branch code, e.g. `00001`)

These are **tax-critical, admin-only** — same posture as `tax_id`. They are **NOT**
member-self-editable (the member portal profile edit MUST NOT expose them). Default = สำนักงานใหญ่
(`true` / `null`); for the 131-member import, admins override only the genuine branches.

Downstream (not this contract, but the reason it exists): `member-identity-adapter.ts:getForIssue`
reads the two columns (L47-84) and writes `buyer_is_head_office` + `buyer_branch_code` onto the
snapshot (L152-174); the snapshot zod adds both fields `.optional().default(...)` (historical
JSONB rows default to head office / null). The receipt renders the buyer branch line **only for a
VAT-registrant juristic buyer** — NOT merely `buyerHasTin` (a natural person's national ID is a
TIN but they have no head office/branch).

## Request

- **Path**: `memberId` (uuid).
- **Headers**: session cookie **+ `Idempotency-Key` (required on PATCH)**.
- **Body** (partial field update; new fields folded into the existing `updateMember` zod):

| field | zod | note |
|---|---|---|
| `is_head_office` | `boolean().optional()` | |
| `branch_code` | `string().regex(/^\d{5}$/).nullable().optional()` | 5-digit branch code |

Cross-field rule (`.superRefine`, mirrors the seller side): `is_head_office === true` ⇒
`branch_code` MUST be null; `false` ⇒ code required `/^\d{5}$/`. Other member fields behave as
today; the route dispatches on body shape (presence of `new_plan_id` routes to change-plan — not
this contract).

## Response `200`

`serialiseMember(member)` including the two new fields (`is_head_office`, `branch_code`). The
response is memoised against the `Idempotency-Key` (replay returns the stored body/status).

## Preconditions

- Member exists in tenant (`not_found` 404 — also the cross-tenant-probe response, indistinguishable).
- Valid `Idempotency-Key` header (missing/malformed → 400; reuse with a different body → 409).

## Error codes (route status map — `route.ts:303-342`)

| code | HTTP | note |
|---|---|---|
| `invalid_body` | 400 | JSON parse / zod failure (incl. new branch/pairing rules) |
| `validation_error` | 400 | domain validation (e.g. proposed **`invalid_branch_code`**) |
| `not_found` | 404 | unknown / cross-tenant |
| `missing_idempotency_key` | 400 | header absent or malformed |
| `idempotency_conflict` | 409 | key reused with different body |
| `idempotency_reservation_failed` | 503 | Upstash outage (Retry-After: 5) |
| `server_error` | 500 | |

## RBAC

- `admin` only. `requireAdminContext(request, { resource:'members', action:'write' })` — a
  `manager` is denied at the guard. **Not exposed on the member self-service portal** (tax-critical
  field, same rule as `tax_id`).

## Audit events

- `member_updated` (F3; carries `{ member_id, fields_changed, diff }`, `update-member.ts:206-209`)
  — `is_head_office` / `branch_code` appear in `fields_changed` + the diff when changed. Surfaces
  on the F3 member timeline. No new audit event type is added.
