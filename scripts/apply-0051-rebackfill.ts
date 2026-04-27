/**
 * One-shot script — apply migration 0051 (F4 retention re-backfill)
 * directly via SQL, sidestepping drizzle-kit migrator (journal vs DB
 * drift is a pre-existing issue in this repo, unrelated to F5).
 *
 * After running this script, manually update the migrations meta journal
 * if/when the team chooses to reconcile.
 *
 * Usage: pnpm tsx scripts/apply-0051-rebackfill.ts
 */
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

async function main(): Promise<void> {
  logger.info({}, 'apply-0051-rebackfill: starting');

  // Pre-count: how many rows are stale at retention=5 for tax-doc types
  const beforeRows = await db.execute<{
    event_type: string;
    count: number;
  }>(sql`
    SELECT event_type::text AS event_type, COUNT(*)::int AS count
    FROM audit_log
    WHERE event_type IN (
      'invoice_issued', 'invoice_paid', 'invoice_voided',
      'credit_note_issued', 'invoice_pdf_resent', 'invoice_pdf_regenerated'
    )
      AND retention_years = 5
    GROUP BY event_type
    ORDER BY event_type
  `);
  const beforeCounts = Array.from(beforeRows);
  logger.info(
    { beforeCounts },
    'apply-0051-rebackfill: pre-update stale-retention counts',
  );

  if (beforeCounts.length === 0) {
    logger.info({}, 'apply-0051-rebackfill: no stale rows — exit clean');
    process.exit(0);
  }

  // Atomic UPDATE inside an explicit tx so the trigger toggle is bounded.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_no_update"
    `);
    const upd = await tx.execute<{ id: string }>(sql`
      UPDATE "audit_log"
         SET "retention_years" = 10
       WHERE "event_type" IN (
         'invoice_issued', 'invoice_paid', 'invoice_voided',
         'credit_note_issued', 'invoice_pdf_resent', 'invoice_pdf_regenerated'
       )
         AND "retention_years" = 5
      RETURNING id
    `);
    await tx.execute(sql`
      ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_no_update"
    `);
    return Array.from(upd).length;
  });

  logger.info(
    { rowsFlipped: result },
    'apply-0051-rebackfill: update complete',
  );

  // Post-count: should be 0
  const afterRows = await db.execute<{
    event_type: string;
    count: number;
  }>(sql`
    SELECT event_type::text AS event_type, COUNT(*)::int AS count
    FROM audit_log
    WHERE event_type IN (
      'invoice_issued', 'invoice_paid', 'invoice_voided',
      'credit_note_issued', 'invoice_pdf_resent', 'invoice_pdf_regenerated'
    )
      AND retention_years = 5
    GROUP BY event_type
  `);
  const afterCounts = Array.from(afterRows);
  if (afterCounts.length === 0) {
    logger.info({}, 'apply-0051-rebackfill: SUCCESS — zero stale rows remain');
    process.exit(0);
  } else {
    logger.error(
      { afterCounts },
      'apply-0051-rebackfill: UNEXPECTED — stale rows remain after update',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'apply-0051-rebackfill: fatal',
  );
  process.exit(1);
});
