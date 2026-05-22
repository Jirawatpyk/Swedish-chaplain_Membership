/**
 * Verify F7.1a schema state on live Neon (ops + incident-triage utility).
 *
 * Created during Phase 2 T020 apply (2026-05-19) to diagnose drift
 * between drizzle journal + live DB, retained per /speckit-verify-run
 * G1 recommendation as a permanent verification tool.
 *
 * Usage:
 *   pnpm tsx scripts/verify-broadcasts-f71a-schema.ts
 *
 * Or as a npm script (see package.json):
 *   pnpm check:f71a-schema
 *
 * Reads DATABASE_URL_UNPOOLED (preferred for schema-introspect queries)
 * or DATABASE_URL from .env.local. Exits with code 1 on any expected-
 * artifact missing — suitable for CI gate or pre-flag-flip check.
 *
 * Verifies:
 *   1. Drizzle migration count + latest applied
 *   2. 4 F71A tables present (broadcast_templates,
 *      broadcast_batch_manifests, tenant_image_source_allowlist,
 *      tenant_broadcast_settings)
 *   3. 5 new columns on broadcasts (manual_retry_count, partial_
 *      delivery_accepted_at/by, started_from_template_id, template_
 *      name_snapshot)
 *   4. 10 F71A audit_event_type enum values
 *   5. RLS+FORCE on all 4 F71A tables + 4 tenant_isolation policies
 *   6. Starter template seed count (15 rows per production tenant
 *      from migration 0168)
 *
 * Per Constitution Principle I sub-clause 4 (DB-layer tenant
 * isolation): this script connects via DATABASE_URL_UNPOOLED which
 * uses the schema-owner role (BYPASS RLS) — appropriate for
 * introspection but MUST NOT be used by request-path code. App
 * runtime uses pooled DATABASE_URL + runInTenant() for tenant scope.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    'verify-broadcasts-f71a-schema: DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.',
  );
  process.exit(1);
}

const EXPECTED_TABLES = [
  'broadcast_batch_manifests',
  'broadcast_templates',
  'tenant_broadcast_settings',
  'tenant_image_source_allowlist',
] as const;

const EXPECTED_BROADCASTS_COLUMNS = [
  'manual_retry_count',
  'partial_delivery_accepted_at',
  'partial_delivery_accepted_by_user_id',
  'started_from_template_id',
  'template_name_snapshot',
] as const;

const EXPECTED_AUDIT_EVENTS = [
  'broadcast_body_image_source_unsafe',
  'broadcast_dispatched_in_batches',
  'broadcast_image_allowlist_updated',
  'broadcast_image_too_large',
  'broadcast_partial_delivery_accepted',
  'broadcast_retry_completed',
  'broadcast_retry_initiated',
  'broadcast_template_created',
  'broadcast_template_deleted',
  'broadcast_template_updated',
] as const;

function check<T>(label: string, expected: number, actual: T[]): boolean {
  const ok = actual.length === expected;
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}: ${actual.length}/${expected}` +
      (ok ? '' : `  MISSING: ${JSON.stringify(actual)}`),
  );
  return ok;
}

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 1, ssl: 'require' });
  let ok = true;

  try {
    console.log('=== F7.1a schema verification on live Neon ===\n');

    // 1) Drizzle migration count + latest applied
    const total = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM drizzle.__drizzle_migrations
    `;
    console.log(`Total drizzle migrations applied: ${total[0]?.c ?? 0}`);

    const latest = await sql<{ id: number; created_at: bigint }[]>`
      SELECT id, created_at FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC LIMIT 3
    `;
    console.log('Latest 3 applied (by created_at):');
    for (const r of latest) {
      console.log(
        `  - id=${r.id}  created_at=${new Date(Number(r.created_at)).toISOString().slice(0, 10)}`,
      );
    }

    // 2) F71A tables present
    console.log('\n[Tables]');
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${sql.array([...EXPECTED_TABLES])}::text[])
      ORDER BY table_name
    `;
    if (!check('F71A tables', 4, tables.map((t) => t.table_name))) ok = false;
    const missingTables = EXPECTED_TABLES.filter(
      (t) => !tables.some((row) => row.table_name === t),
    );
    if (missingTables.length > 0) {
      console.log(`    Missing: ${missingTables.join(', ')}`);
      ok = false;
    }

    // 3) broadcasts columns
    console.log('\n[broadcasts columns]');
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'broadcasts'
        AND column_name = ANY(${sql.array([...EXPECTED_BROADCASTS_COLUMNS])}::text[])
      ORDER BY column_name
    `;
    if (!check('broadcasts F71A columns', 5, cols.map((c) => c.column_name))) ok = false;

    // 4) audit_event_type enum values
    console.log('\n[audit_event_type enum values]');
    const enumVals = await sql<{ enumlabel: string }[]>`
      SELECT enumlabel FROM pg_enum
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'audit_event_type')
        AND enumlabel = ANY(${sql.array([...EXPECTED_AUDIT_EVENTS])}::text[])
      ORDER BY enumlabel
    `;
    if (!check('F71A audit_event_type values', 10, enumVals.map((e) => e.enumlabel))) ok = false;

    // 5) RLS + FORCE policies
    console.log('\n[RLS + FORCE + tenant_isolation policies]');
    const rls = await sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${sql.array([...EXPECTED_TABLES])}::text[])
      ORDER BY c.relname
    `;
    let rlsOk = rls.length === 4;
    for (const r of rls) {
      const tableOk = r.relrowsecurity && r.relforcerowsecurity;
      if (!tableOk) rlsOk = false;
      console.log(
        `  ${tableOk ? '✓' : '✗'} ${r.relname}  RLS=${r.relrowsecurity}  FORCE=${r.relforcerowsecurity}`,
      );
    }
    if (!rlsOk) ok = false;

    const policies = await sql<{ tablename: string; policyname: string }[]>`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(${sql.array([...EXPECTED_TABLES])}::text[])
      ORDER BY tablename
    `;
    if (!check('tenant_isolation policies', 4, policies)) ok = false;

    // 6) Starter template seed (per production tenant)
    console.log('\n[Starter template seed (migration 0168)]');
    const seededByTenant = await sql<{ tenant_id: string; c: number }[]>`
      SELECT tenant_id, COUNT(*)::int AS c
      FROM broadcast_templates
      WHERE is_seeded = TRUE
      GROUP BY tenant_id
      ORDER BY tenant_id
    `;
    if (seededByTenant.length === 0) {
      console.log('  ⚠ No seeded templates found — migration 0168 may not have applied or no production tenants exist');
    } else {
      for (const row of seededByTenant) {
        const expected = 15; // 5 templates × 3 locales
        const tenantOk = row.c === expected;
        if (!tenantOk) ok = false;
        console.log(
          `  ${tenantOk ? '✓' : '✗'} ${row.tenant_id}: ${row.c}/${expected} seeded`,
        );
      }
    }

    console.log(`\n=== Result: ${ok ? 'PASS' : 'FAIL'} ===`);
    process.exit(ok ? 0 : 1);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('verify-broadcasts-f71a-schema: unhandled error:', err);
  process.exit(1);
});
