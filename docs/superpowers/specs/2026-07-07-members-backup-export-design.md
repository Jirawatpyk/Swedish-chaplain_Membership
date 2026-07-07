# Members Backup Export (ZIP) — Design

**Date**: 2026-07-07
**Status**: Approved (brainstorm with maintainer, Thai session)
**Owner module**: `src/modules/insights` (owns all export surfaces: Directory Export, GDPR archive)

## Purpose

Admins need a one-click **backup / data-migration export** of the whole member base.
The existing export surfaces do not cover this:

- Directory Export (E-Book/PDF + JSON) exports only `listed = true` members with public-profile fields.
- GDPR data export is per-member (data-subject archive), not a tenant-wide dump.
- `/api/admin/invoices/export.csv` covers paid invoices only, with a date range.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Primary purpose | Backup / data migration (not reporting, not mail-merge) |
| Row scope | **ALL members, every status** (`active`, `inactive`, `archived`); ignores any UI filter |
| Contacts | Separate `contacts.csv` in the same ZIP, linked by `member_number` |
| Payment data | Separate `invoices.csv` in the same ZIP — every invoice, every status, with `paid_at` + `payment_method` (this IS the member payment history; both offline bank-transfer and Stripe/PromptPay payments end up on the invoice) |
| Access | **Admin only** — manager / member / anonymous rejected by `requireAdminContext` (401 anonymous / 403 wrong-role — same behaviour as the invoices CSV route); the use-case's own `forbidden` → 404 cloak remains as defence-in-depth |
| Delivery | **Synchronous** GET route streaming an in-memory ZIP (Approach A). Async F9 export-job (Approach B) rejected as overkill at SweCham scale (~131 members / ~164 contacts / a few hundred invoices); 3-separate-downloads (Approach C) rejected — user wants one backup artifact |

## Architecture

```
"Export" button on /admin/members (admin-visible only)
        │ GET /api/admin/members/export.zip
        ▼
route handler (src/app/api/admin/members/export.zip/route.ts, runtime nodejs)
        │ requireAdminContext → non-admin 404
        ▼
use-case: exportMembersBackup (src/modules/insights/application/use-cases/)
        │ single runInTenant(ctx, tx) — all reads through tx (RLS enforced)
        │ port: MembersBackupSource (application/ports/)
        ▼
infrastructure: drizzle-members-backup-source.ts — SQL over
  members ⋈ membership_plans ⋈ contacts ⋈ invoices
        ▼
CSV builders (pure, unit-testable) → 3 files, each UTF-8 with BOM,
every cell through src/lib/csv.ts toCsvField (RFC-4180 + formula-injection defang)
        ▼
zip via fflate zipSync (existing dependency, used by F9 GDPR archive)
        ▼
Response: application/zip, Content-Disposition attachment,
filename `<tenant>-members-backup-YYYYMMDD-HHmm.zip` (Asia/Bangkok local time),
Cache-Control: no-store, X-Robots-Tag: noindex,
X-Row-Count headers per file for the toast
```

Insights module already has the correct Clean-Architecture pattern for cross-module
reads (GDPR archive source adapter reads members/contacts/invoices tables in its own
infrastructure layer); this feature follows the same shape. No new npm dependencies.

## ZIP contents

All three files join on `member_number` (the human-readable `SCCM-NNNN` string).
All timestamps ISO 8601 UTC (Gregorian — Buddhist Era is display-only, never in data files).

### members.csv — one row per member, all statuses

```
member_number, company_name, legal_entity_type, tax_id, is_head_office,
website, founded_year, plan, plan_year, registration_fee_paid, status,
address_line1, address_line2, city, province, postal_code, country,
preferred_locale, last_activity_at, risk_band, notes, created_at,
archived_at, erased_at
```

- `plan` = plan display name (EN) resolved via membership_plans join; raw `plan_id` intentionally omitted (backup is for humans/migration, not internal keys — `member_number` is the stable join key).
- GDPR-erased members appear **as stored** (already-redacted tombstone) with `erased_at` set. The export never resurrects erased PII.

### contacts.csv — live contacts only (`removed_at IS NULL`)

```
member_number, first_name, last_name, email, phone, role_title,
preferred_language, is_primary, date_of_birth, created_at
```

Soft-removed contacts are historical noise for a backup and are excluded (matches
how every admin surface treats them).

`date_of_birth` (collected only for Thai Alumni; excluded from default API
responses) IS included: a backup that silently drops a column is a migration trap,
and this egress is already admin-only + audited. If the maintainer later wants it
out, it is a one-line column removal.

### invoices.csv — every invoice, every status

```
member_number, document_number, receipt_number, invoice_subject, status,
currency, subtotal, vat, total, issue_date, due_date, paid_at, payment_method
```

`document_number` is `COALESCE(bill_document_number_raw, document_number)` —
the 088 bill-first numbering stream's tax-invoice/receipt number when one has
been issued, falling back to the legacy `document_number` otherwise. 13 columns.

Invoice lines, credit notes, and PDF artifacts are **out of scope** (see below).

## Security & compliance

- **RBAC**: `requireAdminContext` — admin only; manager/member/anonymous rejected
  with 401 (anonymous) / 403 (wrong role) — same behaviour as the invoices CSV
  route. The use-case's own `forbidden` → 404 cloak remains as defence-in-depth.
- **Audit**: new event type `members_backup_exported` (5-year retention), emitted by
  the use-case on success with per-file row counts in metadata. Bulk PII egress must
  be attributable (Constitution Principle I audit sub-clause).
  - Cost acknowledged: new audit enum value = 1 Drizzle migration + the 4 canonical
    touch-points (domain const, pgEnum, audit-event.test count, completeness.test count).
- **Tenant isolation**: all reads inside one `runInTenant` transaction using `tx`
  (never the global `db`); integration test includes a cross-tenant probe (Review-Gate
  blocker per Constitution Principle I).
- **CSV injection**: every cell through `toCsvField` (neutralises leading `= + - @ \t \r`).
- **Logs**: row counts + tenant slug + hashed actor only — no member PII in logs.

## UI

- "Export" button (download icon) in the `/admin/members` header toolbar next to
  "New member"; rendered for admins only (server-side role check on the page,
  endpoint enforces regardless).
- Click → direct navigation/download of the ZIP; success + failure toasts (sonner).
- i18n keys in EN/TH/SV from day one (`check:i18n` gate).
- Follows docs/ux-standards.md (focus ring, ≥24px target, aria-label).

## Error handling

- Empty tenant → valid ZIP with header-only CSVs (HTTP 200, zero rows) — not an error.
- Use-case failure → 500 `{ error: { code: 'server_error' } }` + pino error log; button shows destructive toast.
- Non-admin requests → 401 (anonymous) / 403 (wrong role) from `requireAdminContext`; the use-case's `forbidden` → 404 cloak is defence-in-depth only.

## Testing (TDD)

1. **Unit** — CSV builders: RFC-4180 escaping, BOM present, formula-injection
   neutralised, erased-member row shape, empty-input → header-only.
2. **Contract** — route: guard rejection forwarded (401/403) for manager/member/anonymous;
   200 ZIP for admin with exactly 3 entries; headers (content-type, disposition, no-store).
3. **Integration (live Neon dev branch)** — seeded tenant: all 3 files contain the
   seeded rows; `members_backup_exported` audit row written; cross-tenant probe
   (tenant B's data never appears in tenant A's export).
4. Audit-event parity tests updated (the 4 touch-points).

## Out of scope (explicitly rejected for now)

- Async export-job / Blob delivery (Approach B) — revisit only when a tenant's data
  volume makes the sync route slow (>5–10k members).
- Filter-aware export (export only the filtered subset) — backup semantics are "everything".
- `invoice_lines.csv`, `credit_notes.csv`, payment-gateway (F5 `payments`) rows,
  invoice PDF files — accounting-grade backup is a separate feature if ever needed.
- Manager access.
- Import/restore tooling (this is egress only).
