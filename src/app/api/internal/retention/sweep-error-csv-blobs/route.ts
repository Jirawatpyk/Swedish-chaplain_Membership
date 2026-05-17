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
import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { gateF6Cron } from '@/lib/events-cron-deps';
import { runSweepExpiredErrorCsvBlobs } from '@/lib/events-csv-import-deps';

export const runtime = 'nodejs';

const ROUTE = '/api/internal/retention/sweep-error-csv-blobs';

// Use POST — this route mutates state (deletes Blob objects + clears DB
// columns). GET semantics imply safe + idempotent, which web crawlers,
// browser prefetch, and Vercel edge cache assume. cron-job.org accepts
// POST trigger; the docs/runbooks/cron-jobs.md coordinator entry must
// be updated on ship day.
export async function POST(request: NextRequest): Promise<Response> {
  // CR-2 / I-2 (R1 — code-reviewer): use the shared `gateCronBearerOrRespond`
  // helper to align with F8/F4/F5/F7 cron coordinators. The helper emits
  // `cron_bearer_auth_rejected` audit + bumps the IP rate-limit on 401 +
  // returns 429 on excessive rejections — closing the silent-401 gap
  // flagged as a Constitution Principle I clause 4 violation.
  const gate = await gateF6Cron(request, ROUTE);
  if (gate) return gate;

  const startedAtMs = Date.now();
  const requestId = randomUUID();
  try {
    const result = await runSweepExpiredErrorCsvBlobs({});
    // If the bulk-scan step failed, surface as 500 so cron-job.org's
    // "2 consecutive failures" alert can detect a sustained outage.
    // Discriminated outcome makes the scan-failed shape disjoint
    // from the success counters (no accidental sweptCount:5 +
    // scan_failed).
    if (result.kind === 'scan_failed') {
      return NextResponse.json(
        {
          ok: false,
          error: 'sweep_scan_failed',
          requestId,
          durationMs: Date.now() - startedAtMs,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        candidatesScanned: result.candidatesScanned,
        sweptCount: result.sweptCount,
        skippedCount: result.skippedCount,
        cutoff: result.cutoff.toISOString(),
        durationMs: Date.now() - startedAtMs,
        requestId,
      },
      { status: 200 },
    );
  } catch (e) {
    logger.error(
      {
        event: 'f6_error_csv_sweep_cron_threw',
        route: ROUTE,
        requestId,
        err: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - startedAtMs,
      },
      '[F6.1] sweep cron threw — operator should investigate (cron-job.org alerts on ≥2 consecutive failures per T058)',
    );
    return NextResponse.json(
      { ok: false, error: 'sweep_cron_failed', requestId },
      { status: 500 },
    );
  }
}
