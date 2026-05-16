/**
 * F5 anti-drift parity test — `audit_event_type` ↔ `F5AuditEventType`.
 *
 * Backfills the F7-pioneered parity-test pattern (see
 * `tests/integration/broadcasts/audit-event-type-parity.test.ts`) onto
 * F5 payments. Asserts that every F5 audit event in the
 * `audit_event_type` Postgres enum has a matching entry in
 * `F5_AUDIT_RETENTION_YEARS` (the canonical exhaustive runtime map of
 * `F5AuditEventType` union members) and vice versa.
 *
 * Scope filter: F5 owns event types prefixed with `payment_`, `refund_`,
 * `out_of_band_refund_`, `stale_pending_`, `dispute_`, `webhook_`,
 * `tenant_payment_`, `online_payment_`. The `audit_event_type` enum is
 * shared across F1+F2+F3+F4+F5+F7 — without this filter the SQL→TS
 * direction would falsely flag every other feature's events as F5 drift.
 */
import { describe, expect, it } from 'vitest';

import { F5_AUDIT_RETENTION_YEARS } from '@/modules/payments/application/ports/audit-port';
import { getEnumParity } from '../helpers/assert-enum-parity';

const F5_PREFIXES = [
  'payment_',
  'refund_',
  'out_of_band_refund_',
  'stale_pending_',
  'dispute_',
  'webhook_',
  'tenant_payment_',
  'online_payment_',
] as const;

/**
 * F6.1 (EventCreate CSV import + webhook ingestion) added a family
 * of `webhook_*` audit event types in migration 0150 that share the
 * `webhook_` prefix with F5 but belong to a different module. Exclude
 * them explicitly here so the parity test doesn't false-positive
 * detect F6 events as missing from the F5 TS union.
 */
const F6_WEBHOOK_EXCLUSIONS = new Set([
  'webhook_receipt_verified',
  'webhook_replay_rejected',
  'webhook_duplicate_rejected',
  'webhook_malformed_rejected',
  'webhook_rolled_back',
  'webhook_secret_grace_used',
  'webhook_test_invoked',
  'webhook_secret_generated',
  'webhook_secret_rotated',
  'webhook_rate_limit_exceeded',
  'webhook_secret_force_expired',
  'webhook_ingest_precondition_failed',
]);

function isF5Event(label: string): boolean {
  if (F6_WEBHOOK_EXCLUSIONS.has(label)) return false;
  return F5_PREFIXES.some((p) => label.startsWith(p));
}

describe('F5 audit_event_type ↔ F5AuditEventType parity', () => {
  it('every F5 TS-union value exists in pg_enum, and every F5-prefixed pg_enum value is in the TS union', async () => {
    const tsValues = Object.keys(F5_AUDIT_RETENTION_YEARS);

    const result = await getEnumParity({
      typeName: 'audit_event_type',
      tsValues,
      sqlScopeFilter: isF5Event,
    });

    expect(
      { missingInSql: result.missingInSql, missingInTs: result.missingInTs },
      `Drift detected:\n  SQL missing TS values: ${JSON.stringify(result.missingInSql)}\n  TS union missing SQL values: ${JSON.stringify(result.missingInTs)}\n\nAdd a migration to extend audit_event_type, OR update F5AuditEventType + F5_AUDIT_RETENTION_YEARS in src/modules/payments/application/ports/audit-port.ts.\n\nNote: if the new event type does NOT match the F5 prefix list extend F5_PREFIXES in this test.`,
    ).toEqual({ missingInSql: [], missingInTs: [] });
  });
});
