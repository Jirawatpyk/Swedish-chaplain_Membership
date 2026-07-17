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
// /review Full Scope 2026-05-19 — explicit `force-dynamic` to match
// project-wide cron-route convention (precedent: PR #22 +
// 2026-05-19 F1/F4 fix batch). Route uses `verifyCronBearer`,
// admin-bypass Drizzle reads + per-row Vercel Blob delete +
// `runInTenant(...)` UPDATE under RLS — every primitive Node-runtime
// + dynamic-execution dependent.
export const dynamic = 'force-dynamic';

const ROUTE = '/api/internal/retention/sweep-error-csv-blobs';

// Vercel-native Cron invokes this path with a GET; the mutating logic
// lives in POST (deletes expired error-CSV Blob objects + clears the DB
// columns). Alias GET → POST so one handler serves both the Vercel cron
// (GET) and the legacy cron-job.org trigger (POST) during migration.
// The earlier "GET is unsafe" concern (web crawler / browser prefetch /
// Vercel edge cache triggering the mutation) is neutralised two ways: the
// shared CRON_SECRET Bearer gate means no secret → no run, and because the
// handler reads the Authorization header the route is rendered dynamically
// (never statically cached). POST is hoisted, so the forward reference is
// safe. See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

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
