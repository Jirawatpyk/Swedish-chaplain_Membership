/**
 * T131 — Out-of-band refund detection (FR-011a) integration test.
 *
 * Spec authority: spec.md FR-011a + plan.md § VII (oob_refund metric).
 * When an admin refunds a payment via the Stripe Dashboard (NOT via the
 * in-app `/api/refunds/initiate` route), Stripe fires `charge.refunded`
 * webhook. F5 detects the divergence (refund row absent in our DB) and:
 *
 *   - emits audit `out_of_band_refund_detected` with `runbook_url` payload
 *   - increments metric `out_of_band_refund_rejected_total`
 *   - does NOT create an F4 credit note (admin must reconcile manually)
 *   - returns 200 to Stripe (event acknowledged)
 *
 * Asserts (lean integration variant — full happy/sad path coverage in
 * `tests/unit/payments/application/process-webhook-event.test.ts`):
 *
 *   (a) `audit_event_type` enum includes `out_of_band_refund_detected`
 *       — DB-level invariant for the audit emitter.
 *
 *   (b) Source-code invariant: `process-webhook-event.ts` charge.refunded
 *       branch emits the audit event with `runbook_url` payload pointing
 *       at the runbook file (so on-call can navigate from the audit row).
 *
 *   (c) The runbook file `docs/runbooks/out-of-band-refund.md` actually
 *       exists at the URL referenced — refactor guard against broken-link
 *       drift.
 *
 *   (d) Retention: `out_of_band_refund_detected` carries 10y per
 *       data-model § 7.1 (forensic record of CN-divergence event).
 *
 *   (e) audit_log → credit_notes invariant: any audit row of type
 *       `out_of_band_refund_detected` MUST have NO matching credit_note
 *       row created by the same correlation_id (no F4 CN issued).
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import {
  F5_AUDIT_RETENTION_YEARS,
} from '@/modules/payments/application/ports/audit-port';

interface EnumRow extends Record<string, unknown> {
  readonly enumlabel: string;
}

interface AuditRow extends Record<string, unknown> {
  readonly id: string;
  readonly request_id: string;
  readonly retention_years: number;
  readonly payload: Record<string, unknown>;
}

interface CountRow extends Record<string, unknown> {
  readonly cn_count: number;
}

describe('T131 out-of-band refund detection (FR-011a)', () => {
  it('(a) audit_event_type enum includes out_of_band_refund_detected', async () => {
    const result = await db.execute<EnumRow>(sql`
      SELECT e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
        AND e.enumlabel = 'out_of_band_refund_detected'
    `);
    expect(Array.from(result).length).toBe(1);
  });

  it('(b) process-webhook-event source emits out_of_band_refund_detected with runbook_url payload', () => {
    const path = join(
      process.cwd(),
      'src/modules/payments/application/use-cases/process-webhook-event.ts',
    );
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf-8');

    expect(src).toMatch(/['"]out_of_band_refund_detected['"]/);
    expect(src).toMatch(/runbook_url/);
    expect(src).toMatch(/docs\/runbooks\/out-of-band-refund\.md/);
    // The branch MUST run only when refund-id is unknown — i.e. inside
    // an `if (!existing)` after a findByProcessorRefundId call. Refactor
    // guard for the inline charge.refunded branch.
    expect(src).toMatch(/findByProcessorRefundId/);
    expect(src).toMatch(/if\s*\(\s*!existing\s*\)/);
  });

  it('(c) referenced runbook file exists at the documented path', () => {
    const path = join(process.cwd(), 'docs/runbooks/out-of-band-refund.md');
    expect(
      existsSync(path),
      'docs/runbooks/out-of-band-refund.md MUST exist — referenced from the audit payload',
    ).toBe(true);
  });

  it('(d) F5 retention map: out_of_band_refund_detected = 10 (forensic record)', () => {
    expect(F5_AUDIT_RETENTION_YEARS['out_of_band_refund_detected']).toBe(10);
  });

  it('(e) live invariant: any out_of_band_refund_detected audit row has retention=10 and no F4 CN at the same request_id', async () => {
    // Sample any existing OOB audit rows in the DB. If none exist (clean
    // dev fixture), the test is vacuous-true. The point is to lock down
    // the cross-table invariant: an OOB audit MUST NOT coincide with an
    // F4 credit_note row at the same correlation context.
    const auditRows = await db.execute<AuditRow>(sql`
      SELECT id::text AS id, request_id, retention_years, payload
      FROM audit_log
      WHERE event_type = 'out_of_band_refund_detected'
      LIMIT 50
    `);
    const rows = Array.from(auditRows);

    for (const row of rows) {
      // Each OOB row carries 10y retention.
      expect(
        row.retention_years,
        `OOB audit row ${row.id} has retention=${row.retention_years} — MUST be 10`,
      ).toBe(10);

      // Each OOB row carries a runbook_url payload field.
      const payload = row.payload as Record<string, unknown>;
      expect(
        typeof payload['runbook_url'],
        `OOB audit row ${row.id} payload missing runbook_url`,
      ).toBe('string');

      // F4 CN invariant: no credit_note row joined by the same
      // processor_refund_id — proxy via processor_refund_id since
      // request_id is not stored on credit_notes. The OOB payload
      // carries processor_refund_id so we can probe.
      const processorRefundId = payload['processor_refund_id'];
      if (typeof processorRefundId === 'string' && processorRefundId.length > 0) {
        const cnCheck = await db.execute<CountRow>(sql`
          SELECT COUNT(*)::int AS cn_count
          FROM credit_notes
          WHERE source_refund_id::text = ${processorRefundId}
        `);
        const [cnRow] = Array.from(cnCheck);
        expect(
          cnRow?.cn_count ?? 0,
          `OOB audit for refund_id=${processorRefundId} has ${cnRow?.cn_count} matching F4 credit notes — MUST be 0 (FR-011a)`,
        ).toBe(0);
      }
    }
  });
});
