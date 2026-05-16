/**
 * T050 (F6.1 · Feature 013 — Phase 5 US5) —
 * GET `/api/internal/retention/sweep-error-csv-blobs`
 *
 * Daily TTL sweep for the 30-day error-CSV Blob retention. Triggered
 * externally by cron-job.org @ 05:00 Asia/Bangkok with email alerts on
 * ≥2 consecutive day failures (operator-gate T058 configures this).
 *
 * Authentication: `Authorization: Bearer ${CRON_SECRET}` — verifyCronBearer
 * helper. Strict in ALL envs (no dev bypass).
 *
 * Pipeline:
 *   1. Verify Bearer.
 *   2. Bulk-read expired rows ACROSS tenants (admin-bypass via the
 *      `csvImportRecordsAdminRepo`).
 *   3. Per row: delete Vercel Blob → clear `error_csv_blob_url` +
 *      `error_csv_expires_at` inside `runInTenant(...)` so RLS approves
 *      the UPDATE.
 *   4. Return `{ ok: true, candidatesScanned, sweptCount, skippedCount,
 *      cutoff }` (200) on success.
 *
 * Idempotent: re-running after a partial failure retries only the rows
 * whose `error_csv_expires_at` is still in the past (blob_not_found is
 * treated as success). Single-tx semantics not needed — each row's
 * delete+clear is independent.
 *
 * Node runtime pinned for Drizzle + Vercel Blob.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { runSweepExpiredErrorCsvBlobs } from '@/lib/events-csv-import-deps';

export const runtime = 'nodejs';

const ROUTE = '/api/internal/retention/sweep-error-csv-blobs';

export async function GET(request: NextRequest): Promise<Response> {
  // 1. Verify Bearer.
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) {
    logger.error(
      {
        event: 'f6_error_csv_sweep_cron_secret_misconfigured',
        route: ROUTE,
      },
      '[F6.1] sweep cron: CRON_SECRET missing or <16 chars; refusing to run',
    );
    return new NextResponse(null, { status: 500 });
  }
  if (!verifyCronBearer(request.headers.get('authorization'), secret)) {
    logger.warn(
      {
        event: 'f6_error_csv_sweep_cron_bearer_rejected',
        route: ROUTE,
      },
      '[F6.1] sweep cron: bearer mismatch — request rejected',
    );
    return new NextResponse(null, { status: 401 });
  }

  const startedAtMs = Date.now();
  try {
    const result = await runSweepExpiredErrorCsvBlobs({});
    return NextResponse.json(
      {
        ok: true,
        candidatesScanned: result.candidatesScanned,
        sweptCount: result.sweptCount,
        skippedCount: result.skippedCount,
        cutoff: result.cutoff.toISOString(),
        durationMs: Date.now() - startedAtMs,
      },
      { status: 200 },
    );
  } catch (e) {
    logger.error(
      {
        event: 'f6_error_csv_sweep_cron_threw',
        route: ROUTE,
        err: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAtMs,
      },
      '[F6.1] sweep cron threw — operator should investigate (cron-job.org will alert on ≥2 consecutive failures per T058)',
    );
    return NextResponse.json(
      { ok: false, error: 'sweep_cron_failed' },
      { status: 500 },
    );
  }
}
