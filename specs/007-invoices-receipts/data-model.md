# F4 Data Model

**Feature**: F4 — Membership Invoicing & Thai-Tax Receipts
**Branch**: `007-invoices-receipts`
**Date**: 2026-04-18
**Migrations**: `drizzle/migrations/0010_invoicing_tables.sql` + `drizzle/migrations/0011_audit_log_f4_extension.sql`

## 1. Overview

Five new tables, one enum extension (to existing `audit_event_type`), four new enums for F4-specific state. All tables tenant-scoped with RLS + FORCE RLS + policy. Monetary amounts stored as `BIGINT` satang (THB × 100) across the board.

### 1.1 Table summary

| Table | Rows/yr @ scale | Purpose |
|---|---|---|
| `invoices` | ~20k | Aggregate root — one row per membership invoice |
| `invoice_lines` | ~30k | Child entity — line items per invoice |
| `credit_notes` | ~500 | Aggregate root — one row per ใบลดหนี้ issued |
| `tenant_invoice_settings` | = tenant count | VAT rate, registration fee, legal identity, numbering, net-days, pro-rate, logo |
| `tenant_document_sequences` | ~60/tenant (over 10 yrs) | Allocator state: next sequence number per (tenant, doc_type, fiscal_year) |

### 1.2 Shared columns (all F4 tables)

- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT`
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()` (auto-bumped by trigger, F2 pattern)
- RLS policy: `USING (tenant_id = current_setting('app.current_tenant', TRUE)::uuid)`
- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`

### 1.3 Cross-cutting rules

- Soft delete is NOT applicable to tax documents — they are legally immutable once issued (FR-030). Only drafts can be deleted, and that delete is hard (the draft never acquired a sequential number, so removing it leaves no gap).
- Append-only audit log: every state transition produces ≥1 row in `audit_log`.
- Snapshots are stored as nullable `_snapshot` columns that are written on first issuance and rejected by trigger on subsequent updates (see § 2.1 trigger).

### 1.4 Money representation

**Rule**: All monetary columns are `BIGINT` in **satang** (1 THB = 100 satang). No `NUMERIC`, no `DECIMAL`, no floats.

**Reason**: Pro-rate math multiplies a factor (4-dp precision) by a fee (satang) and would accumulate float drift in `NUMERIC` when expressed in THB. Satang BIGINT arithmetic is exact. Conversion to display THB happens only at the Money value-object boundary.

**Convention**: Column names end in `_satang` (e.g., `subtotal_satang`, `vat_satang`, `total_satang`) so the unit is self-documenting.

## 2. Tables

### 2.1 `invoices`

Aggregate root. One row per invoice draft / issued / paid / void / credited / partially_credited invoice.

```sql
CREATE TYPE invoice_status AS ENUM (
  'draft',
  'issued',
  'paid',
  'void',
  'credited',
  'partially_credited'
);

CREATE TABLE invoices (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  member_id                       uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  plan_year                       smallint NOT NULL,
  plan_id                         uuid NOT NULL REFERENCES membership_plans(id) ON DELETE RESTRICT,

  -- Lifecycle
  status                          invoice_status NOT NULL DEFAULT 'draft',
  draft_by_user_id                uuid NOT NULL REFERENCES users(id),

  -- Sequential numbering (NULL while draft; set on issue)
  fiscal_year                     smallint,
  sequence_number                 integer,
  document_number                 text,                           -- rendered form, e.g. "SC-2026-000042"

  -- Dates
  issue_date                      date,                           -- set on issue
  due_date                        date,                           -- set on issue (issue_date + net_days_snapshot)
  paid_at                         timestamptz,                    -- set on payment
  voided_at                       timestamptz,                    -- set on void

  -- Pricing snapshots (set on issue, IMMUTABLE thereafter)
  currency                        char(3) NOT NULL DEFAULT 'THB',
  subtotal_satang                 bigint,                         -- sum of invoice_lines.total_satang
  vat_rate_snapshot               numeric(5,4),                   -- e.g. 0.0700 for 7%
  vat_satang                      bigint,                         -- round(subtotal × rate, 2)
  total_satang                    bigint,                         -- subtotal + vat
  credited_total_satang           bigint NOT NULL DEFAULT 0,      -- running sum from credit_notes; updated transactionally

  -- Policy snapshots (IMMUTABLE on issue)
  pro_rate_policy_snapshot        text,                           -- 'none' | 'monthly' | 'daily'
  net_days_snapshot               smallint,

  -- Identity snapshots (IMMUTABLE on issue; stored as jsonb to avoid schema coupling)
  tenant_identity_snapshot        jsonb,                          -- { legal_name_th, legal_name_en, tax_id, address_th, address_en, logo_blob_key }
  member_identity_snapshot        jsonb,                          -- { legal_name, tax_id, address, primary_contact_name, primary_contact_email }

  -- Payment details (set on payment)
  payment_method                  text,                           -- 'bank_transfer' | 'cheque' | 'cash' | 'other'
  payment_reference               text,
  payment_notes                   text,
  payment_recorded_by_user_id     uuid REFERENCES users(id),

  -- Void details (set on void)
  void_reason                     text,
  voided_by_user_id               uuid REFERENCES users(id),

  -- Delivery override (per-invoice override of tenant.auto_email_enabled; FR-024 post-critique)
  auto_email_on_issue             boolean,                        -- NULL = use tenant default at issue time; set at draft time

  -- PDF
  pdf_blob_key                    text,                           -- e.g. "invoicing/{tenant_id}/2026/{id}_v1.pdf"
  pdf_sha256                      char(64),
  pdf_template_version            smallint,                       -- bumped when template changes

  -- Common
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoices_draft_has_no_number
    CHECK (status = 'draft' OR sequence_number IS NOT NULL),
  CONSTRAINT invoices_non_draft_has_snapshots
    CHECK (
      status = 'draft' OR (
        subtotal_satang IS NOT NULL AND vat_rate_snapshot IS NOT NULL
        AND tenant_identity_snapshot IS NOT NULL AND member_identity_snapshot IS NOT NULL
        AND pdf_blob_key IS NOT NULL AND pdf_sha256 IS NOT NULL
      )
    ),
  CONSTRAINT invoices_paid_has_payment
    CHECK (status != 'paid' OR (paid_at IS NOT NULL AND payment_method IS NOT NULL)),
  CONSTRAINT invoices_void_has_reason
    CHECK (status != 'void' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND voided_by_user_id IS NOT NULL)),
  CONSTRAINT invoices_credited_total_in_range
    CHECK (credited_total_satang >= 0 AND (total_satang IS NULL OR credited_total_satang <= total_satang)),
  CONSTRAINT invoices_credited_status_matches
    CHECK (
      (credited_total_satang = 0 AND status NOT IN ('credited','partially_credited'))
      OR (credited_total_satang > 0 AND credited_total_satang < total_satang AND status = 'partially_credited')
      OR (credited_total_satang = total_satang AND status = 'credited')
    )
);

-- Uniqueness — Thai RD §87 enforcement
CREATE UNIQUE INDEX invoices_tenant_fiscal_seq_unique
  ON invoices (tenant_id, fiscal_year, sequence_number)
  WHERE sequence_number IS NOT NULL;

-- Performance indexes
CREATE INDEX invoices_tenant_status_issued
  ON invoices (tenant_id, status, issue_date DESC);
CREATE INDEX invoices_tenant_member_status
  ON invoices (tenant_id, member_id, status);
CREATE INDEX invoices_tenant_due_date_issued
  ON invoices (tenant_id, due_date)
  WHERE status = 'issued';

-- RLS
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant_isolation ON invoices
  USING (tenant_id = current_setting('app.current_tenant', TRUE)::uuid);
```

**Immutability trigger** (F4-specific): a `BEFORE UPDATE` trigger rejects changes to any snapshotted column once `status != 'draft'`. Exceptions: `credited_total_satang`, `status`, `updated_at`, `paid_at`, `payment_*`, `voided_at`, `void_*`, `pdf_blob_key`, `pdf_sha256`, `pdf_template_version` (regenerated on status transitions).

### 2.2 `invoice_lines`

Child entity of Invoice. Deleted-cascaded from invoice only when invoice is a `draft`; once issued, lines are immutable.

```sql
CREATE TYPE invoice_line_kind AS ENUM ('membership_fee', 'registration_fee');

CREATE TABLE invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invoice_id           uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind                 invoice_line_kind NOT NULL,
  description_th       text NOT NULL,
  description_en       text NOT NULL,
  unit_price_satang    bigint NOT NULL CHECK (unit_price_satang >= 0),
  quantity             numeric(10,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  pro_rate_factor      numeric(6,4),                              -- NULL if kind = registration_fee
  total_satang         bigint NOT NULL,                           -- round(unit_price × quantity × coalesce(pro_rate_factor,1), 0) in satang
  position             smallint NOT NULL,                         -- render order
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_lines_total_non_negative
    CHECK (total_satang >= 0)
);

CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id, position);
CREATE INDEX invoice_lines_tenant ON invoice_lines (tenant_id);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_lines_tenant_isolation ON invoice_lines
  USING (tenant_id = current_setting('app.current_tenant', TRUE)::uuid);
```

Invariant (Domain + unit index): exactly one row with `kind = 'membership_fee'` per invoice (spec Key Entities). Enforced at Domain layer; DB does not constrain because the invariant is business-level, not referential.

### 2.3 `credit_notes`

Aggregate root. One row per issued ใบลดหนี้.

```sql
CREATE TABLE credit_notes (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  original_invoice_id             uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,

  -- Numbering (always set — no draft stage for credit notes)
  fiscal_year                     smallint NOT NULL,
  sequence_number                 integer NOT NULL,
  document_number                 text NOT NULL,

  -- Issuance
  issue_date                      date NOT NULL,
  issued_by_user_id               uuid NOT NULL REFERENCES users(id),
  reason                          text NOT NULL,

  -- Amounts (proportional slice of original)
  credit_amount_satang            bigint NOT NULL CHECK (credit_amount_satang > 0),
  vat_satang                      bigint NOT NULL CHECK (vat_satang >= 0),
  total_satang                    bigint NOT NULL,                -- credit_amount + vat

  -- Identity snapshots (copied from original invoice at issue time for determinism)
  tenant_identity_snapshot        jsonb NOT NULL,
  member_identity_snapshot        jsonb NOT NULL,

  -- PDF
  pdf_blob_key                    text NOT NULL,
  pdf_sha256                      char(64) NOT NULL,
  pdf_template_version            smallint NOT NULL,

  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- Thai RD §87 on credit-note stream (if tenant uses separate numbering)
CREATE UNIQUE INDEX credit_notes_tenant_fiscal_seq_unique
  ON credit_notes (tenant_id, fiscal_year, sequence_number);

-- Performance
CREATE INDEX credit_notes_tenant_original
  ON credit_notes (tenant_id, original_invoice_id);

ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_notes_tenant_isolation ON credit_notes
  USING (tenant_id = current_setting('app.current_tenant', TRUE)::uuid);
```

**Invariant (Application-layer, FR-022)**: before insert, `invoices.credited_total_satang + NEW.credit_amount_satang <= invoices.total_satang`. Enforced transactionally via `SELECT … FOR UPDATE` on the parent invoice row.

### 2.4 `tenant_invoice_settings`

One row per tenant (enforced by UNIQUE on `tenant_id`).

```sql
CREATE TYPE pro_rate_policy AS ENUM ('none', 'monthly', 'daily');
CREATE TYPE numbering_reset_cadence AS ENUM ('yearly', 'perpetual');

CREATE TABLE tenant_invoice_settings (
  id                                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                           uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

  -- Tax config
  vat_rate                            numeric(5,4) NOT NULL,       -- current rate; snapshot on each invoice

  -- Fees
  registration_fee_satang             bigint NOT NULL DEFAULT 0 CHECK (registration_fee_satang >= 0),

  -- Legal identity
  legal_name_th                       text NOT NULL,
  legal_name_en                       text NOT NULL,
  tax_id                              text NOT NULL,
  registered_address_th               text NOT NULL,
  registered_address_en               text NOT NULL,

  -- Numbering
  invoice_number_prefix               text NOT NULL,               -- e.g. "SC"
  invoice_number_reset_cadence        numbering_reset_cadence NOT NULL DEFAULT 'yearly',
  receipt_numbering_mode              text NOT NULL DEFAULT 'combined', -- 'combined' | 'separate'
  credit_note_number_prefix           text NOT NULL,               -- e.g. "CN"

  -- Fiscal year
  fiscal_year_start_month             smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),

  -- Due date + pro-rate
  default_net_days                    smallint NOT NULL DEFAULT 30 CHECK (default_net_days BETWEEN 0 AND 365),
  pro_rate_policy                     pro_rate_policy NOT NULL DEFAULT 'monthly',

  -- Logo
  logo_blob_key                       text,

  -- Delivery
  auto_email_enabled                  boolean NOT NULL DEFAULT true,    -- tenant-level default for per-invoice override
  billing_reply_to_email              text,                             -- Reply-To header for auto-emails; nullable, falls back to inviting admin email
  billing_from_name                   text,                             -- tenant-branded sender display name; nullable, falls back to "Chamber-OS Billing"
  tenant_logo_count                   integer NOT NULL DEFAULT 0 CHECK (tenant_logo_count >= 0 AND tenant_logo_count <= 50),  -- monotonic counter; upload refused beyond 50 (R3-E5 / R2-E5)

  -- Receipt numbering (post-critique round 2 — default 'combined')
  -- (column moved here for grouping; see 'receipt_numbering_mode' above)

  created_at                          timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_invoice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_invoice_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_invoice_settings_isolation ON tenant_invoice_settings
  USING (tenant_id = current_setting('app.current_tenant', TRUE)::uuid);
```

### 2.5 `tenant_document_sequences`

Allocator state. One row per `(tenant_id, document_type, fiscal_year)` tuple.

```sql
CREATE TYPE document_type AS ENUM ('invoice', 'receipt', 'credit_note');

CREATE TABLE tenant_document_sequences (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_type                   document_type NOT NULL,
  fiscal_year                     smallint NOT NULL,
  next_sequence_number            integer NOT NULL DEFAULT 1 CHECK (next_sequence_number >= 1),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_type, fiscal_year)
);

ALTER TABLE tenant_document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_document_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_document_sequences_isolation ON tenant_document_sequences
  USING (tenant_id = current_setting('app.current_tenant', TRUE)::uuid);
```

**Allocation protocol** (inside every issue transaction):

```
1. pg_advisory_xact_lock(hashtext('invoicing:' || tenant_id || ':' || doc_type || ':' || fiscal_year))
2. INSERT INTO tenant_document_sequences (tenant_id, document_type, fiscal_year, next_sequence_number)
   VALUES ($1, $2, $3, 1)
   ON CONFLICT (tenant_id, document_type, fiscal_year) DO NOTHING
3. SELECT next_sequence_number FROM tenant_document_sequences
   WHERE tenant_id = $1 AND document_type = $2 AND fiscal_year = $3
   FOR UPDATE
4. UPDATE tenant_document_sequences SET next_sequence_number = next_sequence_number + 1
   WHERE ...
5. Use the read-back value as the new document's sequence_number
```

## 3. State machines

### 3.1 Invoice

```
                ┌──────────────────── void-reason ────────┐
                │                                         ▼
draft ──issue──▶ issued ──record-payment──▶ paid              void
                  │                           │
                  │                           │
                  │                      issue-credit-note
                  │                           │
                  │                           ▼
                  │                  ┌─ partially_credited ─┐
                  │                  │                      │
                  │             issue another              issue another
                  │             partial credit              full credit
                  │                  │                      │
                  │                  └─────────┬────────────┘
                  │                            ▼
                  │                         credited
                  ▼
           draft-delete (removes row)
```

- `draft → issued`: consumes sequence number; immutable thereafter.
- `issued → paid`: payment recording; optional separate receipt sequence.
- `issued → void`: terminal; sequence number kept.
- `paid → partially_credited`: first partial credit note.
- `partially_credited → partially_credited`: further partials.
- `partially_credited → credited`: when `credited_total_satang = total_satang`.
- `paid → credited`: full credit note in one shot.
- Terminal states (`void`, `credited`, fully-credited invoices): no further transitions.

Derived: `overdue = (status = 'issued' AND current_date > due_date)`. Not a stored transition.

### 3.2 Credit note

Single-state (no lifecycle — immutable from creation).

## 4. Audit event extension (migration `0011`)

Adds 15 new values to `audit_event_type`:

```
invoice_draft_created, invoice_draft_updated, invoice_draft_deleted,
invoice_issued, invoice_paid, invoice_voided,
invoice_overdue_detected,
credit_note_issued,
tenant_invoice_settings_updated,
invoice_pdf_resent, receipt_pdf_resent, credit_note_pdf_resent,
invoice_cross_tenant_probe, credit_note_cross_tenant_probe,
pdf_render_failed, auto_email_delivery_failed
```

(16 strings above; `invoice_draft_updated` is bundled but some drafts are edited without external event — emit only on field-level diffs worth auditing; conservatively include it.)

Each statement wrapped in `DO $$ BEGIN ALTER TYPE audit_event_type ADD VALUE '…'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` for idempotency.

**Payload conventions**:
- `invoice_issued` payload: `{ invoice_id, member_id, fiscal_year, sequence_number, document_number, total_satang, pdf_sha256 }`
- `invoice_paid`: `{ invoice_id, payment_method, payment_reference, payment_date, recorded_by_user_id }`
- `invoice_voided`: `{ invoice_id, reason, voided_by_user_id }`
- `credit_note_issued`: `{ credit_note_id, original_invoice_id, credit_amount_satang, vat_satang, total_satang, reason }`
- `invoice_cross_tenant_probe`: `{ attempted_invoice_id, actor_user_id, actor_tenant_id, route }`
- `pdf_render_failed`: `{ invoice_id?, credit_note_id?, reason, template_version, retry_count }`

**Retention**: F4 audit events retained ≥ **10 years** from `created_at` (matches FR-029 tax-document retention, extends F1-F3's 5-year baseline).

**Idempotency for `invoice_overdue_detected`** (post-critique round-2 R2-E3):

```sql
-- Partial unique index guaranteeing one emission per invoice per day
CREATE UNIQUE INDEX audit_log_overdue_once_per_day
  ON audit_log (tenant_id, (payload->>'invoice_id'), ((created_at AT TIME ZONE 'Asia/Bangkok')::date))
  WHERE event_type = 'invoice_overdue_detected';
```

Emission uses `INSERT ... ON CONFLICT DO NOTHING`. Concurrent reads that both detect overdue on the same invoice on the same Bangkok-local day will not create duplicate rows; the index guarantees strict once-per-day-per-invoice semantics.

## 5. FR → data-model mapping

| FR | Where enforced |
|---|---|
| FR-001 (draft + issue) | `invoices.status='draft'` + transactional `issue-invoice.ts` |
| FR-002 (pricing math) | `invoice_lines` rows + Domain pricing policies |
| FR-003 (seq number no-gaps) | `tenant_document_sequences` + advisory lock + transactional tx |
| FR-004 (Thai RD PDF) | `pdf_blob_key` + `pdf_sha256` + PDF templates |
| FR-005 (THB THB) | `currency` + satang BIGINT |
| FR-006 (payment fields) | `payment_*` columns on `invoices` |
| FR-007 (idempotent pay) | `idempotency_keys` table + check + `invoices_paid_has_payment` constraint |
| FR-008 (void) | `void_*` columns + `invoices_void_has_reason` constraint |
| FR-009/010/011 (config + snapshots) | `tenant_invoice_settings` + `tenant_identity_snapshot` + `member_identity_snapshot` + immutability trigger |
| FR-012 (RBAC) | Application layer rbac guards + RLS |
| FR-013 (tenant isolation) | RLS + FORCE RLS on all 5 tables |
| FR-014 (member portal list) | Ownership check on `member_id` match to session |
| FR-015 (audit events) | 15 new `audit_event_type` values + `audit_log` payload |
| FR-016 (deterministic PDF) | `pdf_sha256` + pinned template version + content-addressed Blob key |
| FR-017 (UTC storage, BE display) | `timestamptz` + `date` — display conversion in Presentation |
| FR-018 (PDF = TH+EN only) | Template selection; no SV template shipped |
| FR-019 (pro-rate 3 options) | `pro_rate_policy_snapshot` column + enum + Domain policies |
| FR-020-023 (credit notes) | `credit_notes` table + `credited_total_satang` running sum + partial-accumulation invariant |
| FR-024/025/026 (auto-email + resend + failure handling) | `email_outbox` (F3-existing) + dispatcher |
| FR-027/028 (due date + overdue) | `due_date` + derived query predicate |
| FR-029/030/031 (retention + legal obligation) | `ON DELETE RESTRICT` from `members` + audit retention extension to 10 yrs + F9 GDPR export category |
| FR-032 (member page invoices section) | `listInvoicesByMember` use case exposed via barrel |
| FR-033 (F3 timeline integration) | Audit event types consumed by `@/modules/members/application/use-cases/member-timeline.ts` |

## 6. Migration order & rollback

See `plan.md § Migration Rollback Plan`. Summary:

1. `0010_invoicing_tables.sql` — creates 5 tables + enums + RLS + indexes. Forward-only in production; restore via Neon PITR.
2. `0011_audit_log_f4_extension.sql` — idempotent enum extension; cannot be dropped. Forward-fix only.

Both migrations run in order. No data backfill required (fresh feature).
