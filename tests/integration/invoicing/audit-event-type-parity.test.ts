/**
 * F4 anti-drift parity test — `audit_event_type` ↔ `F4AuditEventType`.
 *
 * Backfills the F7-pioneered parity-test pattern (see
 * `tests/integration/broadcasts/audit-event-type-parity.test.ts`) onto
 * F4 invoicing. Asserts that every F4 audit event in the
 * `audit_event_type` Postgres enum has a matching entry in
 * `F4_AUDIT_RETENTION_YEARS` (the canonical exhaustive runtime map of
 * `F4AuditEventType` union members) and vice versa.
 *
 * Drift modes covered:
 *   1. SQL value missing from TS union — runtime INSERT into audit_log
 *      with the new enum value would throw "invalid input value for
 *      enum audit_event_type".
 *   2. TS union value missing from SQL — emit-side `audit.emit({ eventType: ... })`
 *      compiles fine but Postgres rejects the INSERT.
 *
 * Scope filter: F4 owns event types prefixed with `invoice_`,
 * `credit_note_`, `receipt_`, `tenant_invoice_settings_`, `pdf_render_`,
 * and the lone `auto_email_delivery_failed`. The `audit_event_type`
 * enum is shared across F1+F2+F3+F4+F5+F7 — without this filter the
 * SQL→TS direction would falsely flag every other feature's events as
 * F4 drift.
 */
import { describe, expect, it } from 'vitest';

import { F4_AUDIT_RETENTION_YEARS } from '@/modules/invoicing/application/ports/audit-port';
import { getEnumParity } from '../helpers/assert-enum-parity';

describe('F4 audit_event_type ↔ F4AuditEventType parity', () => {
  it('every F4 TS-union value exists in pg_enum, and every F4-prefixed pg_enum value is in the TS union', async () => {
    const tsValues = Object.keys(F4_AUDIT_RETENTION_YEARS);

    // Declarative scope (post-PR #20 review #3) — `prefixes` + `extraInclude`
    // express F4's namespace cleanly without an inline predicate.
    const result = await getEnumParity({
      typeName: 'audit_event_type',
      tsValues,
      prefixes: [
        'invoice_',
        'credit_note_',
        'receipt_',
        'tenant_invoice_settings_',
        'pdf_render_',
      ],
      // F5R3 (2026-05-16) — extraInclude entries that don't match the
      // prefix list cleanly but belong to F4:
      //   * 'auto_email_delivery_failed' — original baseline
      //   * 'tenant_receipt_prefix_changed' — starts with `tenant_` not
      //     `receipt_`; tax-document audit emitted by
      //     updateTenantInvoiceSettings (migration 0145)
      //   * 'invoices_csv_exported' — starts with `invoices_` (plural)
      //     not `invoice_`; emitted by exportPaidInvoicesCsv (mig 0149)
      extraInclude: [
        'auto_email_delivery_failed',
        'tenant_receipt_prefix_changed',
        'invoices_csv_exported',
        // 054-event-fee-invoices (Task 6b) — starts with `registration_`
        // (not an F4 prefix); emitted by `createEventInvoiceDraft` on an
        // ok(null) event-registration lookup. Owned by F4 invoicing
        // (audit-port.ts F4AuditEventType + F4_AUDIT_RETENTION_YEARS).
        'registration_cross_tenant_probe',
      ],
    });

    expect(
      { missingInSql: result.missingInSql, missingInTs: result.missingInTs },
      `Drift detected:\n  SQL missing TS values: ${JSON.stringify(result.missingInSql)}\n  TS union missing SQL values: ${JSON.stringify(result.missingInTs)}\n\nAdd a migration to extend audit_event_type, OR update F4AuditEventType + F4_AUDIT_RETENTION_YEARS in src/modules/invoicing/application/ports/audit-port.ts.\n\nNote: if the new event type does NOT match the F4 prefix list (invoice_/credit_note_/receipt_/tenant_invoice_settings_/pdf_render_) extend the prefixes / extraInclude lists in this test.`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});
