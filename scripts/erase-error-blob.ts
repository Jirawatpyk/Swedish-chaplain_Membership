/**
 * scripts/erase-error-blob.ts
 *
 * Manual DSR-time erasure of a single F6.1 error-CSV Vercel Blob.
 *
 * **Architecture note (staff-review L-R3v2-2 2026-05-16)**: this script
 * operates OUTSIDE `runInTenant` and bypasses the application's
 * tenant-context guard. That is INTENTIONAL — DSR cascades are
 * admin-driven, the Blob URL is the canonical capability for a single
 * specific tenant's data, and there is no tenant-scoped DB write here
 * (the companion `UPDATE csv_import_records` SQL in the runbook is run
 * separately under tenant scope). Equivalent to the daily sweep cron
 * which also uses an admin-bypass repo for the bulk scan + per-row
 * tenant-scoped DB write.
 *
 * Closes staff-review H-NEW-1 (2026-05-16): the prior runbook used
 * `vercel blob del <url>` CLI syntax which (a) is not the correct
 * subcommand (`delete`, not `del`), and (b) the `--token` flag refers
 * to Vercel CLI auth, NOT `BLOB_READ_WRITE_TOKEN`. A DPO running the
 * wrong command during a real GDPR Art. 17 / PDPA §30 request could
 * believe the blob was deleted when it was not.
 *
 * This script calls `del()` from `@vercel/blob` directly with the
 * verified env-var token, which is the same SDK path the daily TTL
 * sweep cron uses (`sweep-expired-error-csv-blobs` use-case →
 * `vercel-blob-error-csv-store.delete()`). Identical semantics:
 * `blob_not_found` → idempotent success; other errors → exit non-zero
 * with diagnostic.
 *
 * Usage:
 *   pnpm tsx scripts/erase-error-blob.ts <blob_url>
 *
 * Required env (loaded from .env.local via tsx + dotenv-flow):
 *   BLOB_READ_WRITE_TOKEN — Vercel Blob SDK token (NOT VERCEL_TOKEN).
 *
 * Exit codes:
 *   0 — blob deleted (or already gone)
 *   1 — usage error (missing arg / bad URL shape)
 *   2 — env not loaded (BLOB_READ_WRITE_TOKEN missing)
 *   3 — Vercel Blob API error (token rejected, network, etc.)
 *
 * Companion runbook: docs/runbooks/f6-manual-erasure.md § F6.1.
 */

import { del } from '@vercel/blob';

async function main(): Promise<number> {
  const blobUrl = process.argv[2];
  if (!blobUrl) {
    process.stderr.write(
      'Usage: pnpm tsx scripts/erase-error-blob.ts <blob_url>\n' +
        'Pass the value of `csv_import_records.error_csv_blob_url`.\n',
    );
    return 1;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(blobUrl);
  } catch {
    process.stderr.write(`ERROR: <blob_url> is not a valid URL: ${blobUrl}\n`);
    return 1;
  }
  if (!parsedUrl.hostname.endsWith('.vercel-storage.com')) {
    process.stderr.write(
      `ERROR: URL host '${parsedUrl.hostname}' is not a Vercel Blob host.\n` +
        'Expected *.vercel-storage.com — refusing to call del() on a non-Vercel URL.\n',
    );
    return 1;
  }

  const token = process.env['BLOB_READ_WRITE_TOKEN'];
  if (!token) {
    process.stderr.write(
      'ERROR: BLOB_READ_WRITE_TOKEN is not set in env.\n' +
        'Load it from .env.local OR `vercel env pull .env.local` first.\n',
    );
    return 2;
  }

  process.stdout.write(`Deleting blob: ${parsedUrl.pathname}\n`);
  try {
    await del(blobUrl, { token });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // `blob_not_found` is idempotent success — the blob was already
    // swept (daily TTL cron) or previously erased.
    if (message.toLowerCase().includes('not_found')) {
      process.stdout.write(
        'OK — blob already absent (blob_not_found). Idempotent success.\n',
      );
      return 0;
    }
    process.stderr.write(`ERROR: Vercel Blob del() failed: ${message}\n`);
    return 3;
  }

  process.stdout.write('OK — blob deleted.\n');
  process.stdout.write(
    'Next step: clear `csv_import_records.error_csv_blob_url` + emit ' +
      '`csv_import_error_csv_manually_erased` audit per runbook § F6.1.\n',
  );
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    process.stderr.write(`UNCAUGHT: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(3);
  });
