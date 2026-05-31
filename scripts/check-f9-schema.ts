/**
 * Verify F9 (Admin Dashboard + Directory + Timeline + Audit) schema state on
 * live Neon — CI gate + pre-flag-flip check (T018).
 *
 * Usage:
 *   pnpm tsx scripts/check-f9-schema.ts      (or: pnpm check:f9-schema)
 *
 * Reads DATABASE_URL_UNPOOLED (preferred for introspection) or DATABASE_URL
 * from .env.local. Exits 1 on any missing/incorrect artifact.
 *
 * Verifies (data-model.md § 9 + plan Constitution I):
 *   1. 4 F9 tables present (dashboard_metrics_cache, smart_insight_dismissals,
 *      directory_listings, export_jobs)
 *   2. RLS + FORCE on all 4 + 4 tenant_isolation policies (Principle I)
 *   3. member_timeline_v view present AND `security_invoker = on`
 *      (NON-NEGOTIABLE — base-table RLS must apply inside the view)
 *   4. export_kind + export_status enums present
 *   5. 14 F9 audit_event_type enum values
 *   6. dashboard stale trigger present on audit_log
 *
 * Per Constitution Principle I sub-clause 4: this script connects via the
 * schema-owner role (BYPASS RLS) — appropriate for introspection but MUST NOT
 * be used by request-path code (which uses pooled DATABASE_URL + runInTenant).
 */
import postgres from 'postgres';

process.loadEnvFile?.('.env.local');

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error('check-f9-schema: DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.');
  process.exit(1);
}

const EXPECTED_TABLES = [
  'dashboard_metrics_cache',
  'directory_listings',
  'export_jobs',
  'smart_insight_dismissals',
] as const;

const EXPECTED_AUDIT_EVENTS = [
  'audit_log_exported',
  'audit_log_queried',
  'dashboard_viewed',
  'data_export_downloaded',
  'data_export_expired',
  'data_export_failed',
  'data_export_generated',
  'data_export_requested',
  'directory_ebook_generated',
  'directory_json_exported',
  'directory_listing_updated',
  'insights_cross_tenant_probe',
  'member_benefit_viewed',
  'smart_insight_dismissed',
] as const;

function check<T>(label: string, expected: number, actual: T[]): boolean {
  const ok = actual.length === expected;
  console.log(
    `  ${ok ? '✓' : '✗'} ${label}: ${actual.length}/${expected}` +
      (ok ? '' : `  GOT: ${JSON.stringify(actual)}`),
  );
  return ok;
}

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 1, ssl: 'require' });
  let ok = true;

  try {
    console.log('=== F9 schema verification on live Neon ===\n');

    // 1) F9 tables present
    console.log('[Tables]');
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${[...EXPECTED_TABLES]})
      ORDER BY table_name
    `;
    if (!check('F9 tables', 4, tables.map((t) => t.table_name))) ok = false;

    // 2) RLS + FORCE + policies
    console.log('\n[RLS + FORCE + tenant_isolation policies]');
    const rls = await sql<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${[...EXPECTED_TABLES]})
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
        AND tablename = ANY(${[...EXPECTED_TABLES]})
      ORDER BY tablename
    `;
    if (!check('tenant_isolation policies', 4, policies)) ok = false;

    // 3) member_timeline_v present + security_invoker = on (NON-NEGOTIABLE)
    console.log('\n[member_timeline_v view]');
    const view = await sql<{ relname: string; reloptions: string[] | null }[]>`
      SELECT c.relname, c.reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'member_timeline_v' AND c.relkind = 'v'
    `;
    if (view.length !== 1) {
      console.log('  ✗ member_timeline_v view NOT FOUND');
      ok = false;
    } else {
      const opts = view[0]!.reloptions ?? [];
      const invoker = opts.some(
        (o) => o === 'security_invoker=true' || o === 'security_invoker=on',
      );
      console.log(
        `  ${invoker ? '✓' : '✗'} member_timeline_v present; security_invoker=${invoker} (reloptions=${JSON.stringify(opts)})`,
      );
      if (!invoker) ok = false;
    }

    // 4) export_kind + export_status enums
    console.log('\n[export enums]');
    const enums = await sql<{ typname: string }[]>`
      SELECT typname FROM pg_type
      WHERE typname = ANY(ARRAY['export_kind', 'export_status']::text[])
      ORDER BY typname
    `;
    if (!check('export_kind/export_status enums', 2, enums.map((e) => e.typname))) ok = false;

    // 5) 14 F9 audit_event_type enum values
    console.log('\n[audit_event_type F9 values]');
    const enumVals = await sql<{ enumlabel: string }[]>`
      SELECT enumlabel FROM pg_enum
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'audit_event_type')
        AND enumlabel = ANY(${[...EXPECTED_AUDIT_EVENTS]})
      ORDER BY enumlabel
    `;
    if (!check('F9 audit_event_type values', 14, enumVals.map((e) => e.enumlabel))) ok = false;

    // 6) dashboard stale trigger on audit_log
    console.log('\n[stale trigger]');
    const trig = await sql<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'trg_f9_flag_dashboard_stale' AND NOT tgisinternal
    `;
    if (!check('trg_f9_flag_dashboard_stale on audit_log', 1, trig)) ok = false;

    // 7) Perf-critical indexes (data-model § 9 / SC-002 support, T098/E1).
    // Existence guard — the planner only *uses* them at scale (so an
    // EXPLAIN-at-dev-scale assertion would be flaky on tiny tables), but their
    // ABSENCE would silently regress the dashboard activity feed (FR-003),
    // audit viewer (FR-008), and timeline (FR-016) at the SC-002 5k scale.
    console.log('\n[perf-critical indexes]');
    const EXPECTED_INDEXES = [
      // Activity feed (FR-003) + audit viewer (FR-008) — migration 0190.
      'audit_log_tenant_ts_idx',
      'audit_log_tenant_event_ts_idx',
      'audit_log_tenant_actor_ts_idx',
      // Member-timeline + per-source keyset indexes (FR-016) — migration 0189.
      'audit_log_member_timeline_idx',
      'invoices_tenant_member_issue_date_idx',
      'payments_tenant_member_completed_idx',
      'broadcasts_tenant_member_sent_idx',
      'renewal_cycles_tenant_member_period_idx',
      'events_tenant_start_date_idx',
      // Sargable expression indexes matching the view's `member_id::text` cast
      // (migration 0196 / code-review max #1). The raw-uuid keyset indexes above
      // stay (they serve non-view uuid-member lookups); these serve the timeline
      // `(member_id)::text = $1` qual. The 0189 full `event_registrations_tenant_member_idx`
      // was dropped (#15 — redundant with the 0131 partial).
      'invoices_tenant_member_text_issue_idx',
      'renewal_cycles_tenant_member_text_period_idx',
      'broadcasts_tenant_member_text_sent_idx',
      'event_registrations_tenant_member_text_idx',
      // Round 2 (migration 0197): payments member-text sargability (#4) +
      // the contacts.linked_user_id index backing the actor-kind EXISTS (#5).
      'payments_tenant_member_text_completed_idx',
      'contacts_tenant_linked_user_text_idx',
    ];
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${EXPECTED_INDEXES})
      ORDER BY indexname
    `;
    if (!check('F9 perf indexes', EXPECTED_INDEXES.length, idx.map((r) => r.indexname))) {
      ok = false;
      const missing = EXPECTED_INDEXES.filter((n) => !idx.some((r) => r.indexname === n));
      console.log(`    Missing: ${missing.join(', ')}`);
    }

    console.log(`\n=== Result: ${ok ? 'PASS' : 'FAIL'} ===`);
    process.exit(ok ? 0 : 1);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('check-f9-schema: unhandled error:', err);
  process.exit(1);
});
