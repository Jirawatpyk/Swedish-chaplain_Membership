# Data Model — F3 Members & Contacts

**Branch**: `005-members-contacts` | **Date**: 2026-04-15
**Source**: [`spec.md`](./spec.md) Key Entities + Functional Requirements + Clarifications Q1–Q5
**Migrations**: `drizzle/migrations/0008_members_contacts.sql` + `0009_audit_log_f3_extension.sql`

---

## 1. Entities

### 1.1 Member (aggregate root)

A company (legal entity) enrolled on one membership plan for one year at a time.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `tenant_id` | `text` NOT NULL | RLS scope | Multi-tenancy column (F2 pattern) |
| `member_id` | `uuid` NOT NULL | PK | UUID v7 (time-ordered) |
| `company_name` | `text` NOT NULL | length 1..200 | For Individual + Thai Alumni tiers, this is the person's display name |
| `legal_entity_type` | `text` NULL | length ≤ 100 | Free text per Q3 (e.g., "บริษัทจำกัด", "AB", "Ltd") |
| `country` | `char(2)` NOT NULL | ISO 3166-1 alpha-2 | Q3 enum; localized name via `i18n-iso-countries` |
| `tax_id` | `text` NULL | length ≤ 50 | Required by FR-009a for Corporate + Partnership tiers; Thai 13-digit checksum when `country = 'TH'` |
| `website` | `text` NULL | length ≤ 200 | URL format (zod) |
| `description` | `text` NULL | length ≤ 2000 | Tenant-localized free text |
| `founded_year` | `int` NULL | 1800..current_year | Used by Start-up duration check (FR-007) |
| `turnover_thb` | `bigint` NULL | ≥ 0 | Stored as integer THB (no decimals); used by turnover validation (FR-006) |
| `plan_id` | `uuid` NOT NULL | FK → `membership_plans.plan_id` | Year-versioned via plan record |
| `plan_year` | `int` NOT NULL | 2020..2100 | Composite with `plan_id` for explicit year on directory filters |
| `registration_date` | `date` NOT NULL | DEFAULT today | Used by Start-up cap window |
| `registration_fee_paid` | `boolean` NOT NULL | DEFAULT false | One-time THB 1,000 fee state for new members |
| `last_activity_at` | `timestamptz` NULL | DEFAULT NULL | Denormalized — updated by a Postgres `AFTER INSERT ON audit_log` trigger that reads `NEW.payload->>'member_id'` (and `NEW.payload->>'related_member_id'` for cascade events) and sets `members.last_activity_at = NEW.timestamp` in the same DB transaction as the audit-log insert. Guarantees no window where an event is logged but the directory timestamp is stale. Used by directory list ORDER BY without a runtime audit-log join. |
| `notes` | `text` NULL | length ≤ 4000 | Admin-only; redacted from member-self GET responses |
| `status` | `member_status` NOT NULL | DEFAULT 'active' | `active` | `inactive` | `archived` |
| `archived_at` | `timestamptz` NULL | non-NULL iff `status = 'archived'` | 90-day undelete window |
| `created_at` | `timestamptz` NOT NULL | DEFAULT NOW() | |
| `updated_at` | `timestamptz` NOT NULL | DEFAULT NOW() | Updated by trigger |

**Relationships**: 1 Plan (FK), N Contacts (inverse FK on `contacts.member_id`).

**State machine** (`status`):

```
active  ──(admin: set inactive)──>  inactive
active  ──(admin: archive)─────>    archived (sets archived_at = NOW())
inactive ─(admin: set active)──>    active
archived ─(admin: undelete, ≤90d)─> active (clears archived_at)
archived ─(>90d)─────────────────>  archived (UI Undelete disabled; data still readable)
```

**Invariants** (enforced at Domain layer):
- Exactly one `Contact` per Member with `is_primary = TRUE` and `removed_at IS NULL` while `status ∈ {active, inactive}` (FR-003). For `status = archived` the rule is suspended.
- `archived_at IS NOT NULL ⇔ status = 'archived'`.
- `tax_id IS NOT NULL` when plan tier ∈ {Premium, Large, Regular, Start-up, Diamond, Platinum, Gold} (FR-009a).
- `country = 'TH' ∧ tax_id IS NOT NULL ⇒ tax_id matches /^\d{13}$/ AND passes Thai 13-digit checksum`.
- `founded_year ≤ EXTRACT(YEAR FROM registration_date)`.
- `turnover_thb ≥ 0` when present.

### 1.2 Contact (child entity of Member)

A human attached to a member.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `tenant_id` | `text` NOT NULL | RLS scope | Denormalized for RLS; mirrors parent member |
| `contact_id` | `uuid` NOT NULL | PK | UUID v7 |
| `member_id` | `uuid` NOT NULL | FK → `members.member_id` ON DELETE RESTRICT | Tenant-scoped FK enforced via composite (`tenant_id`, `member_id`) |
| `first_name` | `text` NOT NULL | length 1..100 | |
| `last_name` | `text` NOT NULL | length 1..100 | |
| `email` | `text` NOT NULL | RFC 5321; length ≤ 254 | Per-tenant unique (see indexes); redacted in logs |
| `phone` | `text` NULL | E.164; length ≤ 20 | Redacted in logs |
| `role_title` | `text` NULL | length ≤ 100 | Free text (e.g., "CFO", "Marketing Manager") |
| `preferred_language` | `char(2)` NOT NULL | DEFAULT 'en' | enum: `en` | `th` | `sv` |
| `is_primary` | `boolean` NOT NULL | DEFAULT false | Exactly one TRUE per member while `removed_at IS NULL` |
| `date_of_birth` | `date` NULL | required ONLY for Thai Alumni (Application-layer rule) | Excluded from default API responses; opt-in via `?include=date_of_birth` admin-only |
| `linked_user_id` | `uuid` NULL | FK → `users.user_id` (F1) | Set on invitation acceptance |
| `removed_at` | `timestamptz` NULL | soft-delete marker | Removed contacts retained for audit |
| `created_at` | `timestamptz` NOT NULL | DEFAULT NOW() | |
| `updated_at` | `timestamptz` NOT NULL | DEFAULT NOW() | |

**Relationships**: N → 1 Member, optional 1 → 1 User (F1).

**Invariants**:
- `is_primary = TRUE ⇒ removed_at IS NULL`.
- A contact bound to a `linked_user_id` cannot be hard-removed; `removed_at` soft-disables the linked user account (Application-layer cascade per spec edge case).

### 1.3 Reserved (not implemented in F3)

- **Plan Assignment History** — derived projection from `audit_log` filtered to `event_type = 'member_plan_changed'` for the timeline view. No table.
- **At-Risk score** — `member_risk_flag` column reserved; populated by F8.

---

## 2. Indexes

```sql
-- Required for performance + uniqueness invariants

-- Member directory filters
CREATE INDEX members_tenant_status_plan_idx
  ON members (tenant_id, status, plan_id);

CREATE INDEX members_tenant_year_idx
  ON members (tenant_id, plan_year);

-- Directory ORDER BY last_activity_at DESC (E10)
CREATE INDEX members_tenant_last_activity_idx
  ON members (tenant_id, last_activity_at DESC NULLS LAST);

-- Member full-text-style search (Q1 / SC-002 — pg_trgm GIN)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX members_company_name_trgm_gin
  ON members USING GIN (company_name gin_trgm_ops);

-- Contacts directory (search + per-member listing)
CREATE INDEX contacts_tenant_member_idx
  ON contacts (tenant_id, member_id)
  WHERE removed_at IS NULL;

-- Per-tenant email uniqueness (FR-021 supports per-tenant uniqueness; spec edge case rationale)
CREATE UNIQUE INDEX contacts_tenant_email_uniq
  ON contacts (tenant_id, lower(email))
  WHERE removed_at IS NULL;

-- Primary-contact invariant (FR-003)
CREATE UNIQUE INDEX contacts_one_primary_per_member
  ON contacts (tenant_id, member_id)
  WHERE is_primary = TRUE AND removed_at IS NULL;

-- Search by contact name + email substring
CREATE INDEX contacts_name_trgm_gin
  ON contacts USING GIN ((first_name || ' ' || last_name) gin_trgm_ops)
  WHERE removed_at IS NULL;

-- Audit-log timeline (US6) — accelerates payload->>'member_id' filter
CREATE INDEX audit_log_member_id_idx
  ON audit_log ((payload->>'member_id'))
  WHERE payload ? 'member_id';
```

All indexes created via `CREATE INDEX CONCURRENTLY` outside the migration transaction (Postgres requirement) — same pattern as F2 plan migrations.

---

## 3. Row-Level Security (RLS) policies

```sql
-- Mirrors F2 pattern (`runInTenant` + SET LOCAL app.current_tenant)

ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;

CREATE POLICY members_tenant_isolation ON members
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY contacts_tenant_isolation ON contacts
  USING (tenant_id = current_setting('app.current_tenant', TRUE))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', TRUE));
```

`audit_log` RLS policy is unchanged from F2 (`tenant_id IS NULL OR tenant_id = current_setting(...)`).

---

## 4. Audit-log extension (`0009_audit_log_f3_extension.sql`)

17 new event types added via top-level `ALTER TYPE audit_event_type ADD VALUE` statements (each outside a transaction block per Postgres rules — same pattern as F2 migration `0007`). Reuses existing `payload jsonb` and `tenant_id` columns from F2 — no new columns.

| Event type | Trigger | Payload (JSON) |
|---|---|---|
| `member_created` | US1 success | `{ member_id, company_name, plan_id, plan_year, primary_contact_id }` |
| `member_updated` | US3 partial update | `{ member_id, fields_changed: [..], diff: { field: { old, new } } }` |
| `member_plan_changed` | US3 plan change / bulk | `{ member_id, old_plan_id, new_plan_id, override_reason_code?, override_reason_note? }` |
| `member_primary_contact_changed` | US3 promote | `{ member_id, old_primary_contact_id, new_primary_contact_id }` |
| `member_status_changed` | US4 inline status edit | `{ member_id, old_status, new_status }` |
| `member_archived` | US7 archive | `{ member_id, reason? }` |
| `member_undeleted` | US7 undelete | `{ member_id }` |
| `contact_created` | US3 add contact | `{ member_id, contact_id, is_primary }` |
| `contact_updated` | US3 contact edit | `{ member_id, contact_id, fields_changed }` |
| `contact_removed` | US3 remove contact | `{ member_id, contact_id, was_primary }` |
| `member_self_updated` | US5 success | `{ member_id, fields_changed }` |
| `member_self_update_forbidden` | US5 AS3 forged payload | `{ member_id, attempted_fields }` (PII redacted) |
| `member_cross_tenant_probe` | FR-022 | `{ attempted_member_id, actor_tenant_id }` |
| `plan_bundle_changed` | US3 AS5 (extends F2 audit list — bundle change with real count) | `{ member_id?, plan_id, old_includes_corporate_plan_id, new_includes_corporate_plan_id, affected_member_count }` |
| `member_contact_email_changed` | FR-012a | `{ member_id, contact_id, old_email_hash, new_email_hash, linked_user_id? }` (raw emails NOT stored) |
| `user_sessions_revoked` | FR-012a sub-step | `{ user_id, revoked_count, reason: 'email_change' }` |
| `email_verification_sent` | FR-012a sub-step | `{ user_id, token_id, expires_at }` |
| `email_change_notification_sent_to_old_address` | FR-012a dual-channel | `{ user_id, old_email_hash, revert_token_id, expires_at }` |
| `member_email_change_reverted` (high) | FR-012b revert-token click | `{ member_id, contact_id, user_id, reverted_to_email_hash }` |
| `email_verification_resent` | FR-012c admin action | `{ member_id, contact_id, user_id, new_token_id }` |
| `email_dispatch_failed` (high) | Outbox retry exhausted | `{ outbox_row_id, notification_type, attempts, last_error }` |
| `invitation_bounced` | Resend `email.bounced` | `{ member_id, contact_id, bounce_type }` |
| `bulk_action_rate_limit_exceeded` (high) | FR-019b | `{ action, requested_count, window_used, actor_user_id }` |

`actor_user_id` and `tenant_id` are populated by the audit-log infrastructure (F1 + F2 already carry these as table columns, not payload fields).

---

## 5. Validation rules — summary

| Rule | Layer | Source |
|---|---|---|
| Company name 1..200 chars | Domain | spec Key Entities |
| Country = ISO 3166-1 alpha-2 | Domain (value object) | Q3 |
| `legal_entity_type` ≤ 100 chars free text | Domain | Q3 |
| `tax_id` required for Corporate + Partnership tiers | Application (plan-aware) | Q5 / FR-009a |
| Thai 13-digit + checksum when `country = TH` | Domain (`TaxId` value object) | FR-009a |
| `turnover_thb` ≥ 0; warning if outside plan band | Application (turnover policy) | FR-006 |
| `founded_year` ≤ registration year; warning if Start-up > 2 y | Application (start-up policy) | FR-007 |
| Thai Alumni primary contact age ≤ 35 at plan start | Application (age policy) | FR-008 |
| Override reason: enum + optional 500-char note (`other` ⇒ note required) | Domain (`OverrideReason` value object) + Application | Q1 / FR-006a |
| Email RFC 5321; per-tenant unique | Domain + DB unique index | spec edge case |
| Phone E.164 | Domain (value object) | implicit |
| Bulk action ≤ 100 rows server-side | Application + zod refinement | FR-019a / Q4 |
| Archive only valid when `status ∈ {active, inactive}` | Domain state machine | FR-005 |
| Undelete only valid when archive < 90 days | Domain state machine | FR-005 |
| Primary contact partial-index uniqueness | Database | FR-003 |
| Member self-service field whitelist | Application | FR-014 |
