# Phase 1 — Data Model: CSV Import Primary Path + EventCreate Format Adapter

**Date**: 2026-05-15 · **Feature**: `013-csv-import-eventcreate-format`
**Prerequisites**: [plan.md](plan.md), [research.md](research.md) (Phase 0 complete; all NEEDS CLARIFICATION resolved)

---

## Entities introduced or extended

### 1. `csv_import_records` (NEW)

Persists one row per CSV upload attempt — the source-of-truth for the import-history feature (FR-020 / FR-022) and the back-reference target for error-CSV downloads (FR-021).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `record_id` | `UUID` | PRIMARY KEY · DEFAULT `gen_random_uuid()` | Application-generated branded `CsvImportRecordId` |
| `tenant_id` | `TEXT` | NOT NULL · FK→`tenants.slug` · INDEX | Tenant scope (RLS+FORCE policy enforces) |
| `actor_user_id` | `UUID` | NOT NULL · FK→`users.id` | Branded `UserId`; the admin who ran the import |
| `event_id` | `UUID` | NOT NULL · FK→`events.event_id` ON DELETE RESTRICT · INDEX | Required per FR-003 (admin pre-creates event) |
| `uploaded_at` | `TIMESTAMPTZ` | NOT NULL · DEFAULT `now()` | ISO 8601 UTC; BE display-only |
| `source_format` | `TEXT` | NOT NULL · CHECK (`source_format IN ('eventcreate_csv','generic_csv')`) | Set by adapter detection (R2) |
| `original_filename` | `TEXT` | NOT NULL · CHECK length ≤ 255 | For display in history; sanitised against control chars |
| `original_size_bytes` | `INTEGER` | NOT NULL · CHECK > 0 AND ≤ 5_242_880 | Phase 7 5 MiB cap |
| `rows_total` | `INTEGER` | NOT NULL · CHECK ≥ 0 | Parsed rows (excludes header) |
| `rows_processed` | `INTEGER` | NOT NULL · CHECK ≥ 0 | New inserts |
| `rows_already_imported` | `INTEGER` | NOT NULL · CHECK ≥ 0 | Idempotency-skipped |
| `rows_skipped` | `INTEGER` | NOT NULL · CHECK ≥ 0 | `Status` filter — non-Attending |
| `rows_failed` | `INTEGER` | NOT NULL · CHECK ≥ 0 | Per-row failures (parser + tx) |
| `outcome` | `TEXT` | NOT NULL · CHECK (`outcome IN ('completed','timeout','partial_failure','invalid_header','event_not_found','event_not_owned_by_tenant','unexpected_error')`) | Use-case discriminated union |
| `duration_ms` | `INTEGER` | NOT NULL · CHECK ≥ 0 | Use-case wall-clock |
| `error_csv_blob_url` | `TEXT` | NULL | Set when `rows_failed > 0`; NULL'd by TTL sweep |
| `error_csv_expires_at` | `TIMESTAMPTZ` | NULL · INDEX | Set when `error_csv_blob_url` is set; `uploaded_at + 30 days`; INDEX feeds daily TTL sweep |
| `eventcreate_adapter_metadata` | `JSONB` | NULL | Records unknown-column-names list + payment-status-unknown samples (R5) for product-team review; NULL on generic_csv format |
| `attendee_fingerprint` | `TEXT` | NULL · CHECK length = 16 | SHA-256 truncated to 16 hex chars over the sorted, lowercased list of `attendee_email` values where `Status="Attending"` (FR-019a). Used by FR-019b event-mismatch safety net query. NULL only for legacy/migrated rows; new imports always populate. |
| `created_at` | `TIMESTAMPTZ` | NOT NULL · DEFAULT `now()` | Audit |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL · DEFAULT `now()` | Trigger-managed |

**Indexes**:
- `idx_csv_import_records_tenant_uploaded_at_desc` ON (`tenant_id`, `uploaded_at` DESC) — history page pagination
- `idx_csv_import_records_tenant_event_id` ON (`tenant_id`, `event_id`) — per-event history
- `idx_csv_import_records_error_csv_expires_at` ON (`error_csv_expires_at`) WHERE `error_csv_expires_at IS NOT NULL` — TTL sweep cron query
- `idx_csv_import_records_actor_uploaded_at_desc` ON (`tenant_id`, `actor_user_id`, `uploaded_at` DESC) — admin's own history filter
- `idx_csv_import_records_tenant_fingerprint_uploaded_at` ON (`tenant_id`, `attendee_fingerprint`, `uploaded_at` DESC) WHERE `attendee_fingerprint IS NOT NULL` — feeds FR-019b event-mismatch safety net lookup (30-day window query)

**RLS policies** (Constitution Principle I clause 3):
- ENABLE ROW LEVEL SECURITY · FORCE ROW LEVEL SECURITY
- Policy `csv_import_records_tenant_isolation` USING (`tenant_id = current_setting('app.current_tenant', true)`) — both SELECT and UPDATE
- INSERT policy mirrors SELECT (tenant_id check on row being inserted)
- Cross-tenant integration test in `tests/integration/events/csv-import-cross-tenant-eventcreate.test.ts` proves zero cross-tenant visibility

**Lifecycle**:
1. INSERT row at start of import use-case (`outcome = 'unexpected_error'` placeholder; updated at end)
2. UPDATE row at end of use-case with final counts + outcome + duration_ms
3. If `rows_failed > 0`: separate use-case writes error rows to Blob → UPDATE row with `error_csv_blob_url` + `error_csv_expires_at = now() + interval '30 days'`
4. Daily TTL sweep cron at 05:00 Asia/Bangkok: SELECT rows WHERE `error_csv_expires_at < NOW()` → call `vercelBlob.del(error_csv_blob_url)` → UPDATE row SET `error_csv_blob_url = NULL`
5. Row itself persists indefinitely (counts + metadata are low-PII; tenant retention policy controls archival)

---

### 2. `event_registrations` extension (modify existing F6 table)

Add 1 new column to capture PDPA consent **as a classified boolean** per row (FR-009 + Clarifications Session 2026-05-15 post-critique). Existing F6 columns unchanged.

| New column | Type | Constraints | Notes |
|---|---|---|---|
| `attendee_pdpa_consent_acknowledged` | `BOOLEAN` | NULL | Classification of EventCreate's "Personal Data Protection Consent" cell at import time: `true` when contains "hereby acknowledge" (case-insensitive); `false` when contains "do not consent" (case-insensitive); `null` when missing / unrecognized / generic-CSV imports. **Raw consent text is NOT stored** — PDPA Article 5(1)(c) data minimization. F7 broadcast filter consumes `WHERE attendee_pdpa_consent_acknowledged = true`. |

**Migration**: `0140_event_registrations_attendee_pdpa_consent.sql`
- ALTER TABLE event_registrations ADD COLUMN attendee_pdpa_consent_acknowledged BOOLEAN NULL
- Backfill: existing rows get NULL (no historical PDPA consent captured)
- No index in v1 — F7 broadcast filter currently uses email match + per-member consent flags; once F7 integrates this column an index may be added in a follow-up migration if filter performance degrades
- **Zero-downtime safe**: PostgreSQL `ALTER TABLE ADD COLUMN BOOLEAN NULL` is instant (no row rewrite); rollback = `DROP COLUMN`

**Rollback safety**: column is additive; drop in rollback. No FK breakage.

---

### ~~3. `invoices` extension~~ — DROPPED v1

Per Clarifications Session 2026-05-15 post-critique Q2: the F4 "Pending refund review" badge feature is **removed from v1 scope** due to insufficient volume justification (1 tenant × ~50 events/yr × ~5-10 cancellations × few-linked-to-F4-invoice ≈ 1-3 cases/year). F6 still detects cancellation via re-upload (FR-018), credits back quota, and emits audit — admin manually reconciles by reviewing F6 audit log + F4 invoice list when needed.

No migration 0141. No `signalRefundReview` use-case in F4 barrel. No `csv_import_refund_review_signalled` audit event. No F4 cross-cutting changes. Aligns with Constitution X (Simplicity / YAGNI) and user philosophy "no recycling work — if not needed, drop now."

Migration order reduces from 3 to 2 (0139 + 0140 only).

---

### 4. Application-layer types (new Domain + Application contracts)

**Branded types** (Domain layer — pure types, no framework):

```typescript
// src/modules/events/domain/csv-import-record-id.ts
declare const CsvImportRecordIdBrand: unique symbol;
export type CsvImportRecordId = string & { readonly [CsvImportRecordIdBrand]: true };
export function asCsvImportRecordId(raw: string): CsvImportRecordId { /* unchecked at trust boundary */ }
export function tryCsvImportRecordId(raw: string): Result<CsvImportRecordId, ValidationError> { /* UUID v4 check */ }
```

**Value objects** (Domain layer):

```typescript
// src/modules/events/domain/eventcreate-csv-format.ts
export type CsvAdapterMode = 'eventcreate_csv' | 'generic_csv';

// Per Clarifications Session 2026-05-15 (post-critique): raw consent
// text is NOT stored — only the classified boolean. PDPA Article 5(1)(c)
// data minimization. A null result means "consent status unknown"
// (missing cell / unrecognized wording / generic CSV path).
export type PdpaConsentAcknowledged = true | false | null;

export function classifyPdpaConsent(rawCell: string | null | undefined): PdpaConsentAcknowledged {
  if (rawCell === null || rawCell === undefined) return null;
  const trimmed = rawCell.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed === '-' || trimmed === '–') return null;
  if (trimmed.includes('hereby acknowledge')) return true;
  if (trimmed.includes('do not consent')) return false;
  return null;
}
```

**Discriminated union — ImportCsvOutcome** (extend Phase 7 type in Application layer):

```typescript
// src/modules/events/application/use-cases/import-csv.ts
export type ImportCsvOutcome =
  | { readonly kind: 'completed'; readonly summary: ImportSummary; readonly recordId: CsvImportRecordId }
  | { readonly kind: 'timeout'; readonly recordId: CsvImportRecordId; readonly partialSummary: ImportSummary }
  | { readonly kind: 'invalid_header'; readonly missingColumns: ReadonlyArray<string> }
  | { readonly kind: 'event_not_selected' }                                    // NEW
  | { readonly kind: 'event_not_found'; readonly eventId: string }              // NEW
  | { readonly kind: 'event_not_owned_by_tenant'; readonly eventId: string }    // NEW (cross-tenant probe)
  | {                                                                          // NEW (FR-019b safety net)
      readonly kind: 'event_mismatch_warning';
      readonly priorImports: ReadonlyArray<{
        readonly recordId: CsvImportRecordId;
        readonly eventId: string;
        readonly eventName: string;
        readonly uploadedAt: Date;
      }>;
    }
  | { readonly kind: 'unexpected_error'; readonly message: string };
```

~~**Match preview result type**~~ — DROPPED v1 per Clarifications Session 2026-05-15 post-critique Q5 (US3 cut for smoother UX). The `MatchPreviewResult` type and `match_preview` outcome variant are removed; admin sees match counts in the post-commit result card (existing Phase 7 behaviour).

**Audit event extension** (Application port — extend `F6AuditEventType`):

Add 1 new event type to `audit-port.ts`:

```typescript
csv_import_error_csv_downloaded: {
  readonly severity: Severity;
  readonly actorUserId: UserId;
  readonly recordId: CsvImportRecordId;
  readonly downloadedAt: Date;       // when admin clicked
  readonly sourceIp: string;         // captured from request headers
};
```

`csv_import_completed` payload extended with 1 optional field:

```typescript
csv_import_completed: {
  // ... existing fields from Phase 7 ...
  readonly sourceFormat?: 'eventcreate_csv' | 'generic_csv';  // NEW — Q5/R2 observability
};
```

**ErrorCsvStore port** (new Application port):

```typescript
// src/modules/events/application/ports/error-csv-store.ts
export interface ErrorCsvStore {
  put(input: {
    tenantId: TenantId;
    recordId: CsvImportRecordId;
    csvBytes: Uint8Array;
    expiresAt: Date;
  }): Promise<Result<{ blobUrl: string }, ErrorCsvStoreError>>;

  generateSignedUrl(input: {
    blobUrl: string;
    expiresInSeconds: number;        // typical: 900 (15 min)
  }): Promise<Result<{ signedUrl: string; expiresAt: Date }, ErrorCsvStoreError>>;

  delete(input: { blobUrl: string }): Promise<Result<void, ErrorCsvStoreError>>;
}

export type ErrorCsvStoreError =
  | { readonly kind: 'blob_not_found' }
  | { readonly kind: 'storage_error'; readonly message: string };
```

---

## State transitions

### `csv_import_records.outcome`

```text
┌─────────────────────┐
│ INSERT (placeholder │
│  outcome=unexpected_│
│  error)             │
└──────────┬──────────┘
           │
           ▼
   ┌───────────────┐
   │ Use-case runs │
   └───────┬───────┘
           │
   ┌───────┴────────────────────────────────────────────────────────┐
   │ Final UPDATE: outcome ∈ { completed, timeout, partial_failure,│
   │   invalid_header, event_not_found, event_not_owned_by_tenant, │
   │   unexpected_error }                                          │
   └────────────────────────────────────────────────────────────────┘
```

No further transitions. The row is immutable after final UPDATE (TTL sweep only NULLs `error_csv_blob_url`; does not change `outcome`).

### ~~`invoices.refund_review_state`~~ — DROPPED v1

State machine removed alongside the F4 cross-cutting feature (see Clarifications Session 2026-05-15 post-critique Q2).

---

## Data volume estimates

| Entity | SweCham scale | Growth model |
|---|---|---|
| `csv_import_records` | ~50-100 imports/year/tenant (1-2 per event × 50 events/yr; sometimes re-uploads) | ~100 rows/year/tenant |
| Per-import error-CSV blobs | ~5-15 blobs at any time (30-day TTL window × ~10-15 imports/month) | TTL-managed; steady state |
| `event_registrations.attendee_pdpa_consent_acknowledged` | ~5,000 rows/year/tenant (existing F6 row count; just adds 1 BOOLEAN column) | No row-count change |

All within Neon Postgres `ap-southeast-1` headroom. No scaling concerns at v1.

---

## Migration order + safety

Sequence (each is a separate Drizzle migration, applied in order):

1. **`0139_csv_import_records.sql`** — CREATE TABLE + indexes + RLS+FORCE policies + trigger for `updated_at`. **Zero-downtime safe**: `CREATE TABLE` on a new (empty) table is instant — no existing data to lock or rewrite. CREATE INDEX runs on an empty table so does not block writes. RLS policy attachment is a metadata-only DDL. Idempotent (manual rollback via `DROP TABLE csv_import_records CASCADE`).
2. **`0140_event_registrations_attendee_pdpa_consent.sql`** — ALTER TABLE ADD COLUMN (additive, BOOLEAN). Zero-downtime safe (PostgreSQL adds nullable boolean column instantly without row rewrite); existing rows backfill NULL.

~~3. `0141_invoices_refund_review_state.sql`~~ — DROPPED v1 (see Clarifications Session 2026-05-15 post-critique Q2).

**Rollback**: each migration is reversible — drop the table / column. No data loss possible because v1 ship of this feature has no live data dependencies pre-launch.

**Backfill considerations**:
- `csv_import_records`: empty at launch; populates as admins run imports.
- `event_registrations.attendee_pdpa_consent_acknowledged`: NULL for all historical F6 rows. No retroactive backfill (Phase 7 imports didn't capture this column; future re-uploads of those events will populate via FR-018 update path).

---

## Cross-feature data dependencies (modules touched)

| Module | Touch type | Notes |
|---|---|---|
| `src/modules/events/` (F6) | OWNS — extends Phase 7 surface | Primary feature module |
| `src/modules/invoicing/` (F4) | **UNTOUCHED** in v1 (F4 cross-cutting dropped per Clarifications Session 2026-05-15 post-critique Q2) | No migration, no UI changes, no barrel export. Admin manually reconciles F4 invoices against F6 audit log for cancellation cases (~1-3/year). May revisit in v1.x if volume grows. |
| `src/modules/members/` (F3) | READ-ONLY — match logic against members (existing) | Unchanged; reused |
| `src/modules/auth/` (F1) | READ-ONLY — `UserId` brand + admin RBAC | Unchanged; reused |
| `src/modules/tenants/` (F2) | READ-ONLY — `TenantId` brand + RLS context | Unchanged; reused |
| `src/modules/broadcasts/` (F7) | READ-ONLY (future use) — will consume `attendee_pdpa_consent_acknowledged = true` to filter recipients in a later F7.1 iteration | Not in this feature's scope; column is preparatory |
