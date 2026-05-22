/**
 * One-off cleanup — delete all rows from leaked `test-*` and
 * `test-e2e-*` tenants in production DB.
 *
 * Background: integration tests in `tests/integration/**` create
 * throwaway tenants via `createTestTenant('test-swecham')` and call
 * the closure's `cleanup()` in `afterAll`. When `afterAll` is
 * skipped (vitest worker crash, signal interrupt, network drop
 * mid-test), the test data is orphaned in the DB. Over the F2 R1-R6
 * + F8 + F7 development cycle this accumulated to ~200 leaked
 * tenants in `membership_plans` alone, all with `description.en=''`
 * (matches R3-C1 pre-fix shape).
 *
 * Strategy: mirror `tests/integration/helpers/test-tenant.ts`
 * cleanup closure (lines 96-210) — same FK order, same table set.
 * Runs as `neondb_owner` (BYPASS RLS) via the default `db` client.
 *
 * Audit-log rows are intentionally NOT deleted (append-only trigger
 * blocks DELETE; safe per test-tenant.ts:206-209 — accumulated test
 * audit rows are scoped by tenant_slug and harmless).
 *
 * Usage:
 *   node --env-file=.env.local --import tsx \
 *     scripts/cleanup-leaked-test-tenants.ts          # dry-run
 *   CLEANUP_APPLY=true node --env-file=.env.local --import tsx \
 *     scripts/cleanup-leaked-test-tenants.ts          # apply
 */
import postgres from 'postgres';

const TABLES_IN_FK_ORDER = [
  // F3 tokens + outbox (FK on contact_id)
  'email_change_tokens',
  'notifications_outbox',
  // F7 broadcasts (deliveries needs trigger disable — handled below)
  'broadcasts',
  'marketing_unsubscribes',
  'broadcast_segment_definitions',
  // F5 payments
  'refunds',
  'payments',
  'processor_events',
  'tenant_payment_settings',
  // F4 invoicing (invoice_lines CASCADE from invoices)
  'credit_notes',
  'invoice_lines',
  'invoices',
  'tenant_document_sequences',
  'tenant_invoice_settings',
  // F3 contacts
  'contacts',
  // F2/F8 scheduled changes + renewal cycles + members (composite FK)
  'scheduled_plan_changes',
  'renewal_cycles',
  'members',
  // F2 plans
  'membership_plans',
  // F8 renewal config
  'tenant_renewal_schedule_policies',
  'tenant_renewal_settings',
  // F8 link tokens
  'consumed_link_tokens',
  // F6 events
  'event_registrations',
  'csv_import_records',
  'events',
  'tenant_webhook_configs',
  'eventcreate_idempotency_receipts',
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const apply = process.env.CLEANUP_APPLY === 'true';
  const sql = postgres(url, { ssl: 'require', max: 1 });
  try {
    const tenantsRaw = await sql<{ tenant_id: string }[]>`
      SELECT DISTINCT tenant_id
      FROM membership_plans
      WHERE tenant_id LIKE 'test-%' OR tenant_id LIKE 'test-e2e-%'
      ORDER BY tenant_id;
    `;
    const tenants = tenantsRaw.map((r) => r.tenant_id);
    console.log(
      `Found ${tenants.length} leaked test tenants in membership_plans:`,
    );
    for (const t of tenants) console.log(`  - ${t}`);

    if (!apply) {
      console.log('\nDRY_RUN — no DELETE executed.');
      console.log(
        `Would delete across ${TABLES_IN_FK_ORDER.length} tables per tenant.`,
      );
      console.log('Re-run with CLEANUP_APPLY=true to execute.');
      return;
    }

    console.log(
      `\nApplying cleanup for ${tenants.length} tenants in single transaction...`,
    );
    await sql.begin(async (tx) => {
      // Disable broadcast_deliveries append-only trigger inside the tx.
      await tx`
        ALTER TABLE broadcast_deliveries DISABLE TRIGGER broadcast_deliveries_no_delete
      `;
      // broadcast_deliveries cleanup runs alongside broadcasts; both
      // scoped by tenant_id IN (...).
      const tenantList = sql.unsafe(
        '(' + tenants.map((t) => `'${t}'`).join(',') + ')',
      );
      const deletedCounts: Record<string, number> = {};
      const r = await tx.unsafe(
        `DELETE FROM broadcast_deliveries WHERE tenant_id IN ${tenants.map((t) => `'${t.replace(/'/g, "''")}'`).join(',') === '' ? "('')" : '(' + tenants.map((t) => `'${t.replace(/'/g, "''")}'`).join(',') + ')'}`,
      );
      deletedCounts['broadcast_deliveries'] = r.count;
      await tx`
        ALTER TABLE broadcast_deliveries ENABLE TRIGGER broadcast_deliveries_no_delete
      `;
      for (const table of TABLES_IN_FK_ORDER) {
        const result = await tx.unsafe(
          `DELETE FROM ${table} WHERE tenant_id IN (${tenants.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`,
        );
        deletedCounts[table] = result.count;
      }
      // Summary
      console.log('\nRows deleted per table:');
      for (const [table, count] of Object.entries(deletedCounts)) {
        if (count > 0) console.log(`  ${table}: ${count}`);
      }
      void tenantList; // unused; was reserved if we wanted parameterized binding
    });

    const afterRaw = await sql<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT tenant_id) AS count
      FROM membership_plans
      WHERE tenant_id LIKE 'test-%' OR tenant_id LIKE 'test-e2e-%';
    `;
    console.log(
      `\nAFTER: ${Number(afterRaw[0]!.count)} leaked test tenants remaining (expected 0).`,
    );
    console.log(
      '\nNote: audit_log rows scoped to test tenants are intentionally',
    );
    console.log(
      'NOT deleted (append-only trigger; matches test-tenant.ts:206-209',
    );
    console.log('comment).');
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('cleanup failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
