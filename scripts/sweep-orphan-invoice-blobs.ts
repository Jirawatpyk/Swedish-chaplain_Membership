/**
 * Orphan invoice-PDF blob sweep (post-import housekeeping item 9).
 *
 * Lists every Vercel Blob object under `invoicing/<tenant>/` (cursor-
 * paginated), cross-references EVERY blob-key column in the live DB, and
 * reports keys referenced by nothing. Classification rules + safety model:
 * scripts/lib/orphan-blob-classifier.ts (pure, unit-tested) — unrecognised
 * key patterns are NEVER deleted, even with `--commit`.
 *
 * REFERENCED-KEY SOURCES (every blob-key column, from a schema-wide grep of
 * `blob_key`; VOID overlays overwrite `pdf_blob_key`'s key in place so they
 * need no extra column):
 *   - invoices.pdf_blob_key · invoices.receipt_pdf_blob_key ·
 *     invoices.zero_rate_cert_blob_key ·
 *     invoices.tenant_identity_snapshot->>'logo_blob_key'
 *   - credit_notes.pdf_blob_key ·
 *     credit_notes.tenant_identity_snapshot->>'logo_blob_key'
 *   - tenant_invoice_settings.logo_blob_key
 *   - directory_listings.logo_blob_key (insights — defensive: matches only
 *     if it ever points under the invoicing prefix)
 *   - export_jobs.blob_key (insights — same defensive rationale)
 *
 *   # dry-run (safe default — LIST ONLY, zero writes anywhere):
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.production --import tsx scripts/sweep-orphan-invoice-blobs.ts
 *
 *   # commit — deletes the reported orphans via the Blob API:
 *   TENANT_SLUG=swecham CONFIRM_SWEEP=swecham \
 *     node --env-file=.env.production --import tsx scripts/sweep-orphan-invoice-blobs.ts --commit
 *
 * Guards (all fail LOUD):
 *   - TENANT_SLUG required + pattern-validated (no default).
 *   - `--commit` requires env `CONFIRM_SWEEP=<tenant>` EXACTLY.
 *   - Refuses non-BYPASSRLS DB roles: under RLS every referenced-key SELECT
 *     would return 0 rows, EVERYTHING would classify as orphan, and
 *     `--commit` would delete live tax documents. (Same silent-0 guard as
 *     scripts/import-round3/wipe-core.ts.)
 *   - Refuses `--commit` when the Blob listing is non-empty but the DB
 *     referenced-set is EMPTY (a read failure shaped exactly like the
 *     catastrophe above).
 *
 * Env notes: `.env.production` runs need the usual strict-env dummies (see
 * the run-scripts-against-prod conventions — src/lib/env.ts validates at
 * import). No TSX_TSCONFIG_PATH needed — this graph (lib/db + lib/env)
 * never reaches the Next-vendored 'server-only' marker (same as the wipe).
 * Console output is PII-free: blob keys + counts only (keys carry tenant +
 * document UUIDs, no names/emails).
 */
import { existsSync } from 'node:fs';
import {
  classifyOrphanBlobs,
  type ListedBlob,
  type SweepReport,
} from './lib/orphan-blob-classifier';

// Fill in any vars the operator's shell / --env-file did not already supply
// (loadEnvFile never overrides existing vars). DB/env modules are imported
// LAZILY inside main() so src/lib/env.ts validates AFTER this fill-in —
// same discipline as scripts/wipe-tenant-business-data.ts.
if (existsSync('.env.local')) {
  process.loadEnvFile?.('.env.local');
}

const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

function requireTenantSlug(): string {
  const slug = process.env.TENANT_SLUG ?? '';
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      'TENANT_SLUG env is required and pattern-validated (e.g. ' +
        'TENANT_SLUG=swecham). There is deliberately no default for a sweep.',
    );
  }
  return slug;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const tenantId = requireTenantSlug();

  if (commit && process.env.CONFIRM_SWEEP !== tenantId) {
    throw new Error(
      `--commit requires env CONFIRM_SWEEP=${tenantId} EXACTLY ` +
        '(refusing to delete anything without the explicit confirmation).',
    );
  }

  // Lazy — reaches '@/lib/db' → src/lib/env.ts (validated after the
  // .env.local fill-in above).
  const [{ db }, { sql }, { env }, blobSdk] = await Promise.all([
    import('@/lib/db'),
    import('drizzle-orm'),
    import('@/lib/env'),
    import('@vercel/blob'),
  ]);
  const token = env.blob.readWriteToken;

  // Silent-0 guard (wipe-core precedent): a non-BYPASSRLS role reads 0
  // referenced keys → everything classifies orphan → --commit deletes live
  // tax documents. Refuse up front.
  const roleRows = (await db.execute(
    sql`SELECT (rolbypassrls OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`,
  )) as unknown as Array<{ ok: boolean }>;
  if (roleRows[0]?.ok !== true) {
    throw new Error(
      'sweep-orphan-invoice-blobs: current DB role does not bypass RLS — ' +
        'referenced-key reads would silently return 0 rows and every blob ' +
        'would misclassify as orphan. Run with the owner-role DATABASE_URL.',
    );
  }

  // ---- 1. Enumerate every referenced blob key in the DB -------------------
  const referenced = new Set<string>();
  const addAll = (rows: Array<Record<string, unknown>>): void => {
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (typeof v === 'string' && v.length > 0) referenced.add(v);
      }
    }
  };
  addAll(
    (await db.execute(sql`
      SELECT pdf_blob_key, receipt_pdf_blob_key, zero_rate_cert_blob_key,
             tenant_identity_snapshot->>'logo_blob_key' AS snapshot_logo
      FROM invoices WHERE tenant_id = ${tenantId}`)) as never,
  );
  addAll(
    (await db.execute(sql`
      SELECT pdf_blob_key,
             tenant_identity_snapshot->>'logo_blob_key' AS snapshot_logo
      FROM credit_notes WHERE tenant_id = ${tenantId}`)) as never,
  );
  addAll(
    (await db.execute(sql`
      SELECT logo_blob_key FROM tenant_invoice_settings
      WHERE tenant_id = ${tenantId}`)) as never,
  );
  addAll(
    (await db.execute(sql`
      SELECT logo_blob_key FROM directory_listings
      WHERE tenant_id = ${tenantId}`)) as never,
  );
  addAll(
    (await db.execute(sql`
      SELECT blob_key FROM export_jobs WHERE tenant_id = ${tenantId}`)) as never,
  );

  // ---- 2. List every Blob object under the tenant's invoicing prefix -----
  const prefix = `invoicing/${tenantId}/`;
  const listed: ListedBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await blobSdk.list({
      prefix,
      token,
      limit: 1000,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const b of page.blobs) {
      listed.push({ key: b.pathname, sizeBytes: b.size });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor !== undefined);

  if (commit && listed.length > 0 && referenced.size === 0) {
    throw new Error(
      `sweep-orphan-invoice-blobs: Blob lists ${listed.length} objects but ` +
        'the DB references ZERO keys for this tenant — that shape is a read ' +
        'failure, not a real all-orphan state. Refusing to delete.',
    );
  }

  // ---- 3. Classify + report ----------------------------------------------
  const report: SweepReport = classifyOrphanBlobs(tenantId, listed, referenced);

  console.log(`sweep-orphan-invoice-blobs — tenant ${tenantId} (${commit ? 'COMMIT' : 'dry-run'})`);
  console.log(`  prefix:              ${prefix}`);
  console.log(`  listed:              ${report.listedCount} objects · ${fmtBytes(report.listedBytes)}`);
  console.log(`  referenced in DB:    ${referenced.size} keys (${report.referencedCount} present in Blob)`);
  console.log(`  orphans:             ${report.orphanCount} objects · ${fmtBytes(report.orphanBytes)}`);
  console.log(`  unknown (KEPT):      ${report.unknownKeptCount}`);
  const byKind = new Map<string, number>();
  for (const r of report.rows) {
    if (r.verdict !== 'orphan') continue;
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  }
  for (const [kind, n] of [...byKind.entries()].sort()) {
    console.log(`    orphan ${kind}: ${n}`);
  }
  for (const r of report.rows) {
    if (r.verdict === 'orphan') {
      console.log(`  ORPHAN  ${r.key}  (${r.kind}, ${fmtBytes(r.sizeBytes)})`);
    } else if (r.verdict === 'unknown_kept') {
      console.log(`  UNKNOWN (kept)  ${r.key}  (${fmtBytes(r.sizeBytes)})`);
    }
  }
  if (report.referencedMissing.length > 0) {
    console.log(
      `  ANOMALY — ${report.referencedMissing.length} DB-referenced key(s) ` +
        'ABSENT from Blob (broken download links; nothing deleted, listed for follow-up):',
    );
    for (const k of report.referencedMissing) console.log(`    MISSING ${k}`);
  }

  if (!commit) {
    console.log('\nDry-run only (zero writes). Re-run with --commit and ' +
      `CONFIRM_SWEEP=${tenantId} to delete the ${report.orphanCount} orphan(s).`);
    process.exit(0);
  }

  // ---- 4. Commit: delete orphans one-by-one with per-key result ----------
  let deleted = 0;
  let failed = 0;
  for (const r of report.rows) {
    if (r.verdict !== 'orphan') continue;
    try {
      await blobSdk.del(r.key, { token });
      deleted += 1;
      console.log(`  deleted ${r.key}`);
    } catch (e) {
      failed += 1;
      console.error(
        `  DELETE FAILED ${r.key}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  console.log(`\nDone. deleted=${deleted} failed=${failed} kept_unknown=${report.unknownKeptCount}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
