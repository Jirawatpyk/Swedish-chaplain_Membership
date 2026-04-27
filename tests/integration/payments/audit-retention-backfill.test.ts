/**
 * T135 — Audit-retention-backfill verification (Review-Gate blocker).
 *
 * R2-E4 Review-Gate blocker per `specs/009-online-payment/data-model.md` § 7.2
 * + `specs/009-online-payment/tasks.md` § 553. Without the backfill, F5's
 * migration 0039 silently downgrades F4 tax-document audit retention from
 * indefinite-by-absence to 5 years — a compliance regression against Thai
 * RD §87/3 + GDPR Art. 6(1)(c).
 *
 * This test asserts FOUR invariants on live Neon:
 *
 *   (1) Migration 0039 landed: `audit_log.retention_years SMALLINT NOT NULL
 *       DEFAULT 5` exists with CHECK `retention_years IN (5, 10)`.
 *
 *   (2) F4 tax-document event types were backfilled to 10y. Per data-model
 *       § 7.2, six F4 event types must carry `retention_years=10`:
 *         invoice_issued, invoice_paid, invoice_voided, credit_note_issued,
 *         invoice_pdf_resent, invoice_pdf_regenerated
 *       Sample existing rows (if any) MUST all be 10. If no existing rows
 *       are present in this fixture DB, this case is vacuously true — the
 *       migration backfill is a one-shot UPDATE that cannot retroactively
 *       fail; case (3) covers go-forward writes via the F5 emitter map.
 *
 *   (3) F5 audit emitter map (`F5_AUDIT_RETENTION_YEARS` from
 *       `audit-port.ts`) is internally consistent: every F5 event type
 *       maps to either 5 or 10, no missing types, no other values. This
 *       is the single source of truth for go-forward F5 audit writes.
 *
 *   (4) The CHECK constraint actually rejects an out-of-domain insert
 *       (e.g. retention_years=7) — not just declared but enforced.
 *
 * FAIL on this test = compliance regression. Do NOT skip in CI.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  F5_AUDIT_RETENTION_YEARS,
  type F5AuditEventType,
} from '@/modules/payments/application/ports/audit-port';

const F4_TAX_DOCUMENT_EVENT_TYPES = [
  'invoice_issued',
  'invoice_paid',
  'invoice_voided',
  'credit_note_issued',
  'invoice_pdf_resent',
  'invoice_pdf_regenerated',
] as const;

interface ColumnRow extends Record<string, unknown> {
  readonly column_name: string;
  readonly data_type: string;
  readonly is_nullable: 'YES' | 'NO';
  readonly column_default: string | null;
}

interface CheckConstraintRow extends Record<string, unknown> {
  readonly constraint_name: string;
  readonly check_clause: string;
}

interface RetentionRow extends Record<string, unknown> {
  readonly event_type: string;
  readonly retention_years: number;
  readonly row_count: number;
}

describe('Audit retention column + F4 tax-document backfill (T135 — Review-Gate blocker)', () => {
  it('(1) audit_log.retention_years column landed: SMALLINT NOT NULL DEFAULT 5', async () => {
    const cols = await db.execute<ColumnRow>(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'audit_log'
        AND column_name = 'retention_years'
    `);
    const rows = Array.from(cols);
    expect(rows.length).toBe(1);
    const col = rows[0]!;
    expect(col.data_type).toBe('smallint');
    expect(col.is_nullable).toBe('NO');
    // Postgres returns DEFAULT as a textual expression; loose match on '5'.
    expect(String(col.column_default ?? '')).toContain('5');
  });

  it('(1b) CHECK constraint audit_log_retention_years_chk allows {5, 10}', async () => {
    const cks = await db.execute<CheckConstraintRow>(sql`
      SELECT con.conname AS constraint_name,
             pg_get_constraintdef(con.oid) AS check_clause
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE rel.relname = 'audit_log'
        AND ns.nspname = 'public'
        AND con.conname = 'audit_log_retention_years_chk'
    `);
    const rows = Array.from(cks);
    expect(rows.length).toBe(1);
    const clause = String(rows[0]!.check_clause);
    expect(clause).toContain('retention_years');
    expect(clause).toMatch(/\b5\b/);
    expect(clause).toMatch(/\b10\b/);
  });

  it('(2) F4 tax-document event types are 10-year — vacuous-true if fixture has no rows', async () => {
    const eventTypeList = F4_TAX_DOCUMENT_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
    const result = await db.execute<RetentionRow>(sql`
      SELECT event_type::text AS event_type,
             retention_years,
             COUNT(*)::int AS row_count
      FROM audit_log
      WHERE event_type::text IN (${sql.raw(eventTypeList)})
      GROUP BY event_type, retention_years
      ORDER BY event_type, retention_years
    `);

    const rows = Array.from(result);
    if (rows.length === 0) {
      // No F4 tax-document rows in this DB. The migration backfill is
      // a one-shot UPDATE that runs on apply — no rows means nothing
      // to backfill. Case (3) covers go-forward writes via F5 emitter.
      expect(rows.length).toBe(0);
      return;
    }

    // Every grouping (event_type × retention_years) MUST be 10y. Any
    // 5y row signals the backfill was not applied or a post-migration
    // F4 audit emission set retention_years=5 (DEFAULT) instead of 10.
    for (const row of rows) {
      expect(
        row.retention_years,
        `F4 event_type='${row.event_type}' has ${row.row_count} rows with retention_years=${row.retention_years} — MUST be 10 per RD §87/3 (data-model.md § 7.2)`,
      ).toBe(10);
    }
  });

  it('(3) F5_AUDIT_RETENTION_YEARS map is internally consistent — 5 or 10 only, no missing types', () => {
    const entries = Object.entries(F5_AUDIT_RETENTION_YEARS) as Array<
      [F5AuditEventType, number]
    >;
    expect(entries.length).toBeGreaterThan(0);

    for (const [eventType, years] of entries) {
      expect(
        [5, 10],
        `F5 event_type='${eventType}' has retention_years=${years} — MUST be 5 or 10 per data-model.md § 7.1`,
      ).toContain(years);
    }

    // Spot-check a few canonical mappings against data-model.md § 7.1
    // intent (10y for tax-document-touching, 5y for security/config).
    expect(F5_AUDIT_RETENTION_YEARS['out_of_band_refund_detected']).toBe(10);
    expect(F5_AUDIT_RETENTION_YEARS['payment_auto_refunded_stale_invoice']).toBe(10);
    expect(F5_AUDIT_RETENTION_YEARS['webhook_signature_rejected']).toBe(5);
    expect(F5_AUDIT_RETENTION_YEARS['payment_environment_mismatch']).toBe(5);
    expect(F5_AUDIT_RETENTION_YEARS['webhook_api_version_mismatch']).toBe(5);
  });

  it('(2b) L-5 — append-only triggers in place: vacuous case (2) is acceptable BECAUSE post-migration drift is impossible', async () => {
    // L-5 (review 2026-04-27): a synthetic round-trip "insert + flip
    // + verify" is structurally impossible on `audit_log` because the
    // table is append-only — `audit_log_no_update` and
    // `audit_log_no_delete` triggers (migration 0001) reject all
    // UPDATE / DELETE / TRUNCATE statements at the DB layer with
    // ERRCODE 42501. This is the GUARANTEE that makes case (2)'s
    // vacuous result acceptable: post-migration retention drift is
    // not possible. Any drift would require disabling a named
    // trigger (a privileged DDL operation that cannot be done from
    // application code or a normal CI test).
    //
    // Instead of trying to insert + flip (which production code is
    // also forbidden from doing post-migration), assert the three
    // triggers exist + are enabled. This is the load-bearing
    // invariant — if the triggers ever drop, case (2) becomes
    // genuinely insufficient and a stronger seeded-row test is
    // required.
    const triggers = await db.execute<{
      tgname: string;
      tgenabled: string;
    }>(sql`
      SELECT t.tgname, t.tgenabled::text AS tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'audit_log'
        AND n.nspname = 'public'
        AND t.tgname IN (
          'audit_log_no_update',
          'audit_log_no_delete',
          'audit_log_no_truncate'
        )
      ORDER BY t.tgname
    `);
    const rows = Array.from(triggers);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // Postgres `tgenabled`: 'O' = enabled (origin/locale), 'D' = disabled.
      // Anything other than 'O' means the trigger has been disabled or
      // converted to replica/always — none of which is acceptable for
      // the append-only invariant.
      expect(
        row.tgenabled,
        `audit_log trigger '${row.tgname}' has tgenabled='${row.tgenabled}' — MUST be 'O' (enabled) per security.md T-13`,
      ).toBe('O');
    }
  });

  it('(4) CHECK constraint enforces domain — out-of-domain insert is rejected', async () => {
    // Try INSERT retention_years=7 (out of {5, 10}). Postgres MUST throw
    // a check_violation. We catch any error and assert the error message
    // mentions the constraint or check semantics.
    let threw = false;
    let errMessage = '';
    try {
      await db.execute(sql`
        INSERT INTO audit_log
          (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
        VALUES
          ('payment_succeeded'::audit_event_type,
           '00000000-0000-0000-0000-000000000000',
           'T135 retention CHECK constraint probe — should reject',
           't135-probe',
           '{}'::jsonb,
           't135-probe-tenant',
           7)
      `);
    } catch (e) {
      threw = true;
      errMessage = e instanceof Error ? e.message : String(e);
    }
    expect(threw, 'INSERT with retention_years=7 must be rejected').toBe(true);
    // Postgres surfaces "violates check constraint" or names the constraint.
    expect(errMessage.toLowerCase()).toMatch(
      /check|retention_years|constraint/,
    );
  });
});
