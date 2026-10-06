/**
 * 066-renewal-swecham-round2 (T6-review B2) — BEHAVIORAL guard on the
 * `audit_log_default_retention_for_f4_tax_docs` BEFORE-INSERT trigger.
 *
 * The trigger promotes a set of event types to 10-year retention. It is
 * re-created (CREATE OR REPLACE) by several migrations (0055/0063/0084/
 * 0257/0316); each re-create re-emits the WHOLE IN() list, so a future re-create
 * that drops a type silently regresses that type to the 5y column default —
 * a compliance regression with no other signal. 0257 nearly did exactly
 * this to `member_acknowledged_broadcasts_terms` (0084's GDPR Art. 7 /
 * PDPA §35 consent record).
 *
 * This test inserts a real row of each expected-10y type and asserts the
 * trigger promoted it — so any future trigger re-create that drops a type
 * fails HERE. Runs on live Neon (the trigger only exists in the DB).
 *
 * 0316 deliberately REMOVED `member_acknowledged_broadcasts_terms`: it
 * records a sender's acknowledgement of the E-Blast terms, not consent, so
 * the 0084 consent rationale for 10y no longer applies and it returns to
 * the 5y F7 default (`f7RetentionFor`). It is pinned at 5y below so the
 * removal cannot be undone by a later re-create either.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';

// Every event type the trigger must promote to 10y (the union across
// migrations 0055 + 0063 + 0257, minus the one 0316 removed). Keep in
// lockstep with the IN() list in the LATEST retention-trigger migration.
const EXPECTED_10Y = [
  // F4 tax documents (Thai RD §87/3 + §86/10):
  'invoice_issued',
  'invoice_paid',
  'invoice_voided',
  'credit_note_issued',
  'invoice_pdf_resent',
  'invoice_pdf_regenerated',
  'receipt_pdf_resent',
  'credit_note_pdf_resent',
  'receipt_rendered',
  // F8/F5 post-termination payment forensic (migration 0257 — §4.4(2)):
  'payment_on_terminated_member',
] as const;

// Events that must STAY at the 5y default: a routine F8 control, and the
// E-Blast terms acknowledgement 0316 returned to the F7 default.
const EXPECTED_5Y = ['renewal_lapsed', 'member_acknowledged_broadcasts_terms'] as const;

const MARKER = `retention-trigger-test-${randomUUID()}`;

async function insertAuditRow(eventType: string): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO audit_log (event_type, actor_user_id, summary, request_id)
    VALUES (${eventType}::audit_event_type, 'system:test', ${MARKER}, ${randomUUID()})
    RETURNING retention_years
  `);
  const first = (rows as unknown as Array<{ retention_years: number }>)[0];
  return Number(first!.retention_years);
}

describe('audit_log retention trigger — behavioral guard (066 T6-review B2)', () => {
  afterAll(async () => {
    // audit_log is append-only (audit_log_no_update trigger blocks UPDATE,
    // not DELETE); clean our marker rows as the BYPASSRLS owner.
    await db.execute(sql`DELETE FROM audit_log WHERE summary = ${MARKER}`).catch(() => {});
  });

  it('promotes every expected tax/forensic event type to retention_years=10', async () => {
    for (const eventType of EXPECTED_10Y) {
      const retention = await insertAuditRow(eventType);
      expect(retention, `${eventType} must be 10y`).toBe(10);
    }
  });

  it('leaves renewal_lapsed and member_acknowledged_broadcasts_terms at the 5y default', async () => {
    for (const eventType of EXPECTED_5Y) {
      expect(await insertAuditRow(eventType), `${eventType} must be 5y`).toBe(5);
    }
  });
});
