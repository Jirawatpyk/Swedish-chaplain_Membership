/**
 * Round-3 wipe CLI (Part 3 of the Round-3 import —
 * docs/import/ROUND3_PLAN.md § Wipe + § operational window).
 *
 * Deletes ALL business data for ONE tenant (members, contacts, invoices,
 * payments, renewal cycles, member-portal user accounts, numbering state)
 * while preserving audit_log, processor_events, admin users, system actors,
 * plans, every tenant_* config row, broadcasts and F6 events. Core logic:
 * scripts/import-round3/wipe-core.ts (order: scripts/import-round3/wipe-plan.ts).
 *
 *   # dry-run (safe default — prints per-table counts, ZERO writes)
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/wipe-tenant-business-data.ts
 *
 *   # prod commit — ONLY inside the ROUND3_PLAN window
 *   # (FEATURE_F8_RENEWALS=false + redeploy, Neon PITR point taken first):
 *   TENANT_SLUG=swecham CONFIRM_WIPE=swecham \
 *     node --env-file=.env.production --import tsx scripts/wipe-tenant-business-data.ts --commit
 *
 * Guards (all fail LOUD):
 *   - TENANT_SLUG required + pattern-validated (no default — a wipe must be
 *     an explicit decision).
 *   - `--commit` requires env `CONFIRM_WIPE=<tenant>` EXACTLY.
 *   - Refuses non-BYPASSRLS DB roles (a chamber_app run would silently
 *     delete 0 rows and print a lying report).
 *
 * Env notes: `.env.production` runs need the usual strict-env dummies (see
 * the run-scripts-against-prod conventions — src/lib/env.ts validates at
 * import). No TSX_TSCONFIG_PATH needed — this graph never reaches the
 * Next-vendored 'server-only' marker.
 *
 * Idempotent: a re-run deletes 0 rows everywhere.
 */
import { existsSync } from 'node:fs';

// Fill in any vars the operator's shell / --env-file did not already supply
// (loadEnvFile never overrides existing vars). NOTE: the wipe core is
// imported LAZILY inside main() — a static import would be hoisted ABOVE
// this fill-in and src/lib/env.ts would validate an empty environment
// (same lazy-import discipline as scripts/import-round3-invoices.ts).
if (existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
}

function requireTenantSlug(): string {
  const slug = process.env.TENANT_SLUG ?? '';
  if (slug.length === 0) {
    throw new Error(
      'TENANT_SLUG env is required (e.g. TENANT_SLUG=swecham). ' +
        'There is deliberately no default for a wipe.',
    );
  }
  return slug;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const tenantId = requireTenantSlug();

  // Lazy — reaches '@/lib/db' → src/lib/env.ts (validated AFTER the
  // .env.local fill-in above).
  const { renderWipeReportText, wipeTenantBusinessData } = await import(
    './import-round3/wipe-core'
  );

  const report = await wipeTenantBusinessData(tenantId, { commit });
  console.log(renderWipeReportText(report));

  if (commit) {
    console.log('');
    console.log('NEXT STEPS (operator — per docs/import/ROUND3_PLAN.md):');
    console.log(
      '  1. pnpm seed:system-actors:prod   # idempotent safety — ALWAYS after any wipe',
    );
    console.log(
      '  2. seed 2024 plans → member import --commit → invoice import --commit → verify',
    );
  } else {
    console.log('');
    console.log(
      'DRY-RUN complete — zero writes. Re-run with --commit AND ' +
        `CONFIRM_WIPE=${tenantId} to delete.`,
    );
  }
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('wipe-tenant-business-data.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(
        '[wipe-tenant-business-data] FAILED:',
        e instanceof Error ? e.message : String(e),
      );
      process.exit(1);
    });
}
