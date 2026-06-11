/**
 * Quick schema verification against Neon. Lists tables + audit_log
 * triggers so the operator can confirm the migration landed.
 */
// Loaded via `node --env-file=.env.local` from `pnpm db:verify`.
process.loadEnvFile?.('.env.local');

import postgres from 'postgres';

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL;
  if (!url) {
    console.error('verify-schema: DATABASE_URL is required');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, ssl: 'require' });

  try {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    console.log('Tables in public schema:');
    for (const row of tables) {
      console.log(`  ${row.table_name}`);
    }

    // Query pg_trigger directly — information_schema.triggers does NOT
    // list TRUNCATE triggers, so we'd miss audit_log_no_truncate.
    const triggers = await sql<{ tgname: string; tgtype: number }[]>`
      SELECT t.tgname, t.tgtype
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      WHERE c.relname = 'audit_log'
        AND NOT t.tgisinternal
      ORDER BY t.tgname
    `;
    console.log('\nAudit log triggers:');
    for (const row of triggers) {
      // tgtype bits: 0x04=INSERT 0x08=DELETE 0x10=UPDATE 0x20=TRUNCATE
      const events: string[] = [];
      if (row.tgtype & 0x04) events.push('INSERT');
      if (row.tgtype & 0x08) events.push('DELETE');
      if (row.tgtype & 0x10) events.push('UPDATE');
      if (row.tgtype & 0x20) events.push('TRUNCATE');
      console.log(`  ${row.tgname} (${events.join(', ')})`);
    }

    // R3 M-2 (2026-04-28): canary checks for recent migrations.
    // If the schema is out of sync (e.g. `db:sync-bookkeeping` was
    // run before the actual migrations applied), the canaries below
    // exit non-zero so the operator can detect it BEFORE running
    // `db:migrate` (which would otherwise skip them silently).
    console.log('\nCanary checks:');
    type CanaryRow = { hit: number };
    const canaries: ReadonlyArray<{ name: string; query: string }> = [
      {
        name: 'payments.processor_environment column (mig 0033)',
        query: `SELECT 1 AS hit FROM information_schema.columns WHERE table_name = 'payments' AND column_name = 'processor_environment'`,
      },
      {
        name: 'payments_processor_payment_intent_id_uniq partial index (mig 0054)',
        query: `SELECT 1 AS hit FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'payments_processor_payment_intent_id_uniq' AND indexdef LIKE '%WHERE%status%'`,
      },
      {
        name: 'audit_log.retention_years column (mig 0039)',
        query: `SELECT 1 AS hit FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'retention_years'`,
      },
      {
        name: "audit_event_type enum has 'dispute_created' (mig 0053)",
        query: `SELECT 1 AS hit FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'audit_event_type') AND enumlabel = 'dispute_created'`,
      },
      {
        name: 'audit_log_retention_default_for_f4_tax_docs trigger (mig 0055)',
        query: `SELECT 1 AS hit FROM information_schema.triggers WHERE event_object_table = 'audit_log' AND trigger_name = 'audit_log_retention_default_for_f4_tax_docs'`,
      },
      // 064-event-invoice-paid-flow canaries (migs 0211-0214) — the
      // §105 as-paid path depends on all four; a partially-applied
      // journal here corrupts tax-document invariants silently.
      {
        name: 'invoices.pdf_doc_kind column + invoices_non_draft_has_doc_kind CHECK (mig 0211)',
        query: `SELECT 1 AS hit FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'pdf_doc_kind' AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_non_draft_has_doc_kind' AND conrelid = 'public.invoices'::regclass)`,
      },
      {
        name: 'invoices_non_draft_has_snapshots CHECK has the 0212 relaxed event leg (mig 0212)',
        query: `SELECT 1 AS hit FROM pg_constraint WHERE conname = 'invoices_non_draft_has_snapshots' AND conrelid = 'public.invoices'::regclass AND pg_get_constraintdef(oid) LIKE '%receipt_document_number_raw%'`,
      },
      {
        name: 'invoices_tenant_receipt_raw_uniq partial unique index (mig 0213)',
        query: `SELECT 1 AS hit FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'invoices_tenant_receipt_raw_uniq' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef LIKE '%WHERE%'`,
      },
      {
        name: 'invoices_enforce_immutability locks pdf_doc_kind (mig 0214)',
        query: `SELECT 1 AS hit FROM pg_proc WHERE proname = 'invoices_enforce_immutability' AND prosrc LIKE '%pdf_doc_kind%'`,
      },
    ];
    let failures = 0;
    for (const canary of canaries) {
      const rows = await sql.unsafe<CanaryRow[]>(canary.query);
      const present = rows.length > 0;
      console.log(`  ${present ? '✓' : '✗'} ${canary.name}`);
      if (!present) failures += 1;
    }
    if (failures > 0) {
      console.error(
        `\n✗ ${failures} canary check(s) failed — schema is NOT in sync with the journal.\n` +
          `  → Run \`pnpm db:migrate\` BEFORE \`pnpm db:sync-bookkeeping\`.`,
      );
      process.exit(1);
    }
    console.log(`\n✓ All ${canaries.length} canaries present — schema in sync.`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('verify-schema: crashed:', error);
  process.exit(1);
});
