/**
 * T022a — F4 migration verification probe.
 *
 * Runs a set of `information_schema` / `pg_catalog` SELECTs that
 * assert migrations 0019 + 0020 + 0021 landed with:
 *   - 5 new tables (invoices, invoice_lines, credit_notes,
 *     tenant_invoice_settings, tenant_document_sequences)
 *   - RLS ENABLED + FORCE ENABLED on each
 *   - At least one policy per table
 *   - 5 expected enums (invoice_status, invoice_line_kind,
 *     pro_rate_policy, numbering_reset_cadence, document_type)
 *   - 16 new audit_event_type values
 *   - `audit_log_overdue_once_per_day` partial unique index
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/verify-f4-migrations.ts
 *
 * Exit code 0 on all-green, 1 on any assertion failure. Designed so
 * staging / production rollouts can run this as a gate before traffic
 * flips over. Also reused in CP-2.1 validation (tasks.md T022a).
 */
import postgres from 'postgres';

process.loadEnvFile?.('.env.local');

const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL;
if (!url) {
  console.error('verify-f4-migrations: DATABASE_URL is required.');
  process.exit(1);
}

const EXPECTED_TABLES = [
  'invoices',
  'invoice_lines',
  'credit_notes',
  'tenant_invoice_settings',
  'tenant_document_sequences',
];

const EXPECTED_ENUMS = [
  'invoice_status',
  'invoice_line_kind',
  'pro_rate_policy',
  'numbering_reset_cadence',
  'document_type',
];

const EXPECTED_AUDIT_EVENTS = [
  'invoice_draft_created',
  'invoice_draft_updated',
  'invoice_draft_deleted',
  'invoice_issued',
  'invoice_paid',
  'invoice_voided',
  'invoice_overdue_detected',
  'credit_note_issued',
  'tenant_invoice_settings_updated',
  'invoice_pdf_resent',
  'receipt_pdf_resent',
  'credit_note_pdf_resent',
  'invoice_cross_tenant_probe',
  'credit_note_cross_tenant_probe',
  'pdf_render_failed',
  'auto_email_delivery_failed',
];

type ProbeResult = { check: string; ok: boolean; detail?: string | undefined };

async function main(): Promise<void> {
  const client = postgres(url!, { max: 1, ssl: 'require' });
  const results: ProbeResult[] = [];

  try {
    // ---- 1. Tables exist --------------------------------------------------
    for (const table of EXPECTED_TABLES) {
      const rows = await client<{ rls: boolean; force_rls: boolean }[]>`
        SELECT c.relrowsecurity AS rls,
               c.relforcerowsecurity AS force_rls
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table}
      `;
      if (rows.length === 0) {
        results.push({ check: `table ${table} exists`, ok: false, detail: 'not found' });
        continue;
      }
      const r = rows[0]!;
      results.push({
        check: `table ${table} RLS/FORCE enabled`,
        ok: r.rls === true && r.force_rls === true,
        detail: `rls=${r.rls} force=${r.force_rls}`,
      });

      // Policy count.
      const pols = await client<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table}
      `;
      results.push({
        check: `table ${table} has >=1 policy`,
        ok: Number(pols[0]!.cnt) > 0,
        detail: `policies=${pols[0]!.cnt}`,
      });
    }

    // ---- 2. Enums exist ---------------------------------------------------
    for (const enumName of EXPECTED_ENUMS) {
      const rows = await client<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM pg_type WHERE typname = ${enumName}
      `;
      results.push({
        check: `enum ${enumName} exists`,
        ok: Number(rows[0]!.cnt) === 1,
      });
    }

    // ---- 3. 16 audit_event_type values added ------------------------------
    const enumVals = await client<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'audit_event_type'
    `;
    const present = new Set(enumVals.map((r) => r.enumlabel));
    for (const expected of EXPECTED_AUDIT_EVENTS) {
      results.push({
        check: `audit_event_type has value '${expected}'`,
        ok: present.has(expected),
      });
    }

    // ---- 4. Partial unique index on audit_log for overdue idempotency -----
    const idx = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'audit_log_overdue_once_per_day'
    `;
    results.push({
      check: `audit_log_overdue_once_per_day partial unique index exists`,
      ok: idx.length === 1 && /UNIQUE/i.test(idx[0]!.indexdef),
      detail: idx[0]?.indexdef,
    });

    // ---- 5. Immutability trigger on invoices ------------------------------
    const trig = await client<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt FROM pg_trigger
      WHERE tgname = 'invoices_enforce_immutability_trg'
    `;
    results.push({
      check: `invoices_enforce_immutability_trg trigger exists`,
      ok: Number(trig[0]!.cnt) === 1,
    });

    // ---- Report ----------------------------------------------------------
    let failed = 0;
    for (const r of results) {
      const sign = r.ok ? '✓' : '✗';
      const detail = r.detail ? `  [${r.detail}]` : '';
      console.log(`${sign} ${r.check}${detail}`);
      if (!r.ok) failed++;
    }
    console.log('');
    console.log(`${results.length - failed} / ${results.length} checks passed`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (error) {
    console.error('✗ verify-f4-migrations crashed:', error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
