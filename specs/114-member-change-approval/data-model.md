# Data Model — 114 Member Portal: Approval Workflow for Member Changes

Phase 1 output. Entities from `spec.md` § Key Entities, resolved against the decisions in
`research.md` (R2, R3, R7, R8, R10, R11). DDL is **hand-written SQL** in
`drizzle/migrations/0300_member_change_requests.sql` (journal `when: 1798543200000`); Drizzle
schema in `src/modules/members/infrastructure/db/schema-change-requests.ts`. Drizzle-inferred types
stay in Infrastructure; the Domain types below are hand-declared.

## 1. `member_change_requests`

One row per request. **One `pending` row per submitting person** (partial unique index).

| column | type | notes |
|---|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` | |
| `tenant_id` | `text NOT NULL` | RLS FORCE, strict policy (0209 pattern) |
| `member_id` | `uuid NOT NULL` → `members(id)` | composite FK `(tenant_id, member_id)` as the other member-child tables do |
| `submitted_by_user_id` | `uuid NOT NULL` → `users(id)` | the portal user; attribution for audit + FR-029 scope |
| `submitted_by_contact_id` | `uuid NOT NULL` → `contacts(id)` | the contact record the user was linked to at submission |
| `submitter_role_at_submission` | `text NOT NULL CHECK IN ('primary','secondary')` | shown on the review page (Edge Cases "primary contact changes while pending") |
| `scope` | `text NOT NULL CHECK IN ('company','own_contact','mixed')` | derived from the field keys; `company`/`mixed` only when the submitter was primary (FR-002) |
| `state` | `text NOT NULL CHECK IN ('pending','decided','withdrawn')` | state machine § 4 |
| `outcome` | `text NULL CHECK IN ('approved','partially_approved','rejected')` | set iff `state='decided'` (CHECK) |
| `withdrawn_reason` | `text NULL CHECK IN ('member','replaced','erasure')` | set iff `state='withdrawn'` (CHECK) |
| `replaced_by_request_id` | `uuid NULL` → self | set iff `withdrawn_reason='replaced'` |
| `submitted_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `staff_notified_at` | `timestamptz NULL` | last staff notification for this submitter; inherited on coalesced replacement (R8) |
| `decided_at` | `timestamptz NULL` | |
| `decided_by_user_id` | `uuid NULL` → `users(id)` | the reviewer |
| `decision_reason` | `text NULL CHECK (char_length BETWEEN 1 AND 1000)` | required iff any field rejected (app-enforced; DB CHECK on length only) |
| `decision_note` | `text NULL CHECK (char_length <= 1000)` | optional |
| `withdrawn_at` | `timestamptz NULL` | |
| `outcome_acknowledged_at` | `timestamptz NULL` | set when the submitting person dismisses the decision on their profile (FR-010); one submitter per request, so per-request = per-person |
| `created_at` / `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |

**Indexes**
- `member_change_requests_one_pending_per_submitter` — `UNIQUE (tenant_id, submitted_by_user_id) WHERE state = 'pending'` (R3)
- `member_change_requests_tenant_state_submitted_idx` — `(tenant_id, state, submitted_at DESC)` — queue, pending count, oldest age
- `member_change_requests_tenant_member_idx` — `(tenant_id, member_id, submitted_at DESC)` — per-member history
- `member_change_requests_rate_window_idx` — `(tenant_id, submitted_by_user_id, submitted_at)` — the 24 h cap count (R9)

**CHECKs**: `(state = 'decided') = (outcome IS NOT NULL)`; `(state = 'decided') = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)`; `(state = 'withdrawn') = (withdrawn_reason IS NOT NULL)`.

## 2. `member_change_request_fields`

One row per proposed field **or address group**. Only fields that differ from the record at
submission are stored (FR-005, FR-007).

| column | type | notes |
|---|---|---|
| `id` | `uuid PK` | |
| `tenant_id` | `text NOT NULL` | RLS FORCE |
| `request_id` | `uuid NOT NULL` → `member_change_requests(id) ON DELETE CASCADE` | |
| `field_key` | `text NOT NULL CHECK IN (<Group B keys>)` | see § 3; `registered_address` and `billing_address` are single keys |
| `target` | `text NOT NULL CHECK IN ('member','contact')` | which record the key writes to |
| `seen_value` | `jsonb NULL` | the value the member saw at submission (scalar, or the address object) |
| `proposed_value` | `jsonb NULL` | `null` = clear the field (nullable fields only) |
| `outcome` | `text NULL CHECK IN ('approved','rejected')` | set when the request is decided |
| `applied_at` | `timestamptz NULL` | set iff `outcome='approved'` |
| `affects_tax_documents` | `boolean NOT NULL` | computed at submit: `company_name`, `billing_address`, `registered_address` when the member has no billing address, and `first_name` / `last_name` when the submitter is the primary contact — the buyer block (`MemberIdentitySnapshot.legal_name` / `address` / `primary_contact_name`) is built from these at issue time (FR-019, FR-022) |

Computed **at review time**, never stored: `undecidable = 'contact_removed'` for a `contact`-target row whose contact is removed or unlinked (reject-only, FR-020); `already_current = proposed_value = live value` (approve is a no-op write, still recorded, FR-015).

**Indexes**: `UNIQUE (request_id, field_key)`; `(tenant_id, request_id)`.

**Erasure** (R10): `seen_value` / `proposed_value` → erasure sentinel; row kept.

## 3. Group B field keys (compile-time constant, Domain)

`src/modules/members/domain/change-request/proposable-fields.ts`

| key | target | column(s) | tax flag |
|---|---|---|---|
| `first_name`, `last_name` | contact (own) | `contacts.*` | **yes iff** the submitter is the primary contact (buyer's contact person) |
| `phone`, `role_title` | contact (own) | `contacts.*` | no |
| `company_name` | member | `members.company_name` | **yes** |
| `website`, `description` | member | | no |
| `registered_address` | member | `address_line1, address_line2, sub_district, city, province, postal_code` | **yes iff** billing address unset |
| `billing_address` | member | `billing_address_line1, billing_address_line2, billing_sub_district, billing_city, billing_province, billing_postal_code, billing_country` | **yes** |

Group A (immediate, not a change-request key): `contacts.preferred_language`. Group C: everything
else on `members` / `contacts` — never accepted (FR-003; forged-edit audit).

**Who may propose** (FR-002): `company_*`/`website`/`description`/`*_address` only when the
submitter's contact `is_primary = true` at submission; contact keys only for the submitter's own
`contact_id`. Violations → `member_self_update_forbidden` audit + 403.

## 4. State machine (Domain, pure)

```
                 submit (primary or own-contact fields differ)
   ──────────────────────────────────────────────▶ pending ──┬── decide(all approved)      ─▶ decided / approved
                                                              ├── decide(some rejected)     ─▶ decided / partially_approved
                                                              ├── decide(all rejected)      ─▶ decided / rejected
                                                              ├── withdraw (member)         ─▶ withdrawn / member
                                                              ├── resubmit by same person   ─▶ withdrawn / replaced  (+ new pending)
                                                              └── erasure of the member     ─▶ withdrawn / erasure   (system actor)
   decided | withdrawn are terminal: decide → `already_decided` (no-op if identical), withdraw → `not_pending`
```

Guards on `decide`: member not archived, member not under erasure; a `contact`-target row whose
contact is removed/unlinked is reject-only (FR-020); setting OFF does **not** block (FR-032). Races:
first committed transition wins — withdraw vs decide, replace vs decide (FR-017).
`acknowledge` (submitter dismisses the shown decision) sets `outcome_acknowledged_at` on a decided
request; it is not a state. Glossary: the spec's and the UI's **"dismiss"** (FR-010) is the API's and
the column's **`acknowledge`** — one concept, two audiences. Guards on `submit`: flag on + setting on (else the immediate path), member not archived,
submitter linked + not removed, ≤ 9 requests in the trailing 24 h (R9).

## 5. `tenant_member_settings` (existing) — one new column

`member_change_approval_enabled boolean NOT NULL DEFAULT false` (R11). Written only by
`setMemberChangeApprovalEnabled`; every write audited (`member_change_approval_setting_changed`
with `{ previous, next }`).

## 6. Enum widenings (same migration, one `ALTER TYPE … ADD VALUE` per statement)

- `audit_event_type` += `member_change_request_submitted`, `member_change_request_decided`,
  `member_change_request_withdrawn`, `member_change_request_rate_limited`,
  `member_change_approval_setting_changed` (pinned count 37 → 42; five places per CLAUDE.md).
- `notification_type` += `member_change_request_submitted_staff`,
  `member_change_request_decided_member`.

## 7. Domain types (hand-declared, `src/modules/members/domain/change-request/*.ts`)

```ts
type ChangeRequestState = 'pending' | 'decided' | 'withdrawn';
type ChangeRequestOutcome = 'approved' | 'partially_approved' | 'rejected';
type WithdrawnReason = 'member' | 'replaced' | 'erasure';
type FieldOutcome = 'approved' | 'rejected';
type ProposableFieldKey = (typeof PROPOSABLE_FIELD_KEYS)[number];   // § 3, as const tuple

type ProposedField = { key: ProposableFieldKey; target: 'member' | 'contact';
  seen: JsonValue | null; proposed: JsonValue | null; affectsTaxDocuments: boolean;
  outcome: FieldOutcome | null; appliedAt: Date | null };

type ChangeRequest = { id; tenantId; memberId; submittedByUserId; submittedByContactId;
  submitterRoleAtSubmission: 'primary' | 'secondary'; scope: 'company' | 'own_contact' | 'mixed';
  state; outcome | null; withdrawnReason | null; replacedByRequestId | null;
  submittedAt; staffNotifiedAt | null; decidedAt | null; decidedByUserId | null;
  decisionReason | null; decisionNote | null; withdrawnAt | null; fields: readonly ProposedField[] };

// pure policies
deriveOutcome(fields): ChangeRequestOutcome            // all/some/none approved
deriveScope(keys, submitterIsPrimary): Result<scope, 'company_fields_require_primary'>
diffAgainstRecord(record, proposal): ProposedField[]   // drops equal values; address groups atomic
affectsTaxDocuments(key, memberHasBillingAddress): boolean
changedSinceSubmitted(field, liveValue): boolean       // FR-019 three-value display
```

## 8. Relationships

```
tenants(slug) 1──* member_change_requests *──1 members
                          │ 1
                          └──* member_change_request_fields
users 1──* member_change_requests (submitted_by_user_id, decided_by_user_id)
contacts 1──* member_change_requests (submitted_by_contact_id)
audit_log ← one row per transition (R7)      notifications_outbox ← queued per transition (R8)
member_timeline_v ← audit arm, no view change (R15)
```

## 9. Validation rules (from FR-006, R14)

Per key, the **same** zod rule the staff form uses (`buildMemberFormSchema` / contact schema /
`asPhone`), applied at submit and again at decision against the then-current data. Reason
1–1000 chars, note ≤ 1000, both plain text (rendered escaped, never as markup/links).
