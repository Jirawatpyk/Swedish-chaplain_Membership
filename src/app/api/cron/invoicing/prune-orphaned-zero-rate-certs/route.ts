/**
 * POST `/api/cron/invoicing/prune-orphaned-zero-rate-certs`
 *
 * 088 US8 UX-B2 (T061f) — daily TTL sweep that **deletes ABANDONED / SUPERSEDED
 * §80/1(5) MFA zero-rate certificate SCAN blobs** — files uploaded via the UX-B1
 * upload route (`upload-zero-rate-cert`) onto a DRAFT invoice that was then never
 * issued (dialog cancelled / flipped to standard VAT / superseded by a
 * re-upload). A cert scan is written to a server-derived key
 * `invoicing/<tenantId>/zero-rate-certs/<invoiceId>_<ms>.<ext>` and is only
 * PINNED onto `invoices.zero_rate_cert_blob_key` at ISSUE; a never-issued draft
 * leaves it orphaned, and Vercel Blob has NO TTL — so this cron is the only
 * reclaim path (the invoicing analogue of the F6 error-CSV blob TTL sweep + the
 * sibling of the `redact-expired-*` invoicing crons).
 *
 * A PINNED cert is 10-year-retained legal evidence and is NEVER swept — the
 * use-case KEEPs any blob some invoice pins (even a voided/credited one) and
 * fail-safe-KEEPs anything it cannot confirm is an orphan. Full orphan rule +
 * grace (48h) + idempotency + data-loss guard live in
 * `src/modules/invoicing/application/use-cases/prune-orphaned-zero-rate-certs.ts`.
 *
 * The route is intentionally thin (F6 sweep-route shape): verify the Bearer,
 * delegate to the `runPruneOrphanedZeroRateCerts` composition wrapper, and map
 * the discriminated outcome to HTTP. It carries ZERO `@/modules/invoicing/*`
 * deep imports (the invoicing presentation-import architecture test forbids a
 * route from deep-importing `application/**`; all module wiring lives in the
 * `src/lib/**` composition adapter).
 *
 * Authentication: `Authorization: Bearer ${CRON_SECRET}` (constant-time; strict
 * in all envs, no dev bypass). NOT feature-gated (pure cleanup, safe regardless
 * of the 088 flag). Returns 200 `{ ok, scanned, swept, skipped, cutoff }` (NO
 * PII — cutoff is a time, keys are path segments) / 401 / 500 (scan_failed).
 * Node runtime pinned for Drizzle + Vercel Blob. Runbook:
 * `docs/runbooks/cron-jobs.md` § 088 prune-orphaned-zero-rate-certs.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { runPruneOrphanedZeroRateCerts } from '@/lib/invoicing-cert-prune-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = '/api/cron/invoicing/prune-orphaned-zero-rate-certs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn(
      { requestId, route: ROUTE },
      'cron.prune_orphaned_zero_rate_certs.unauthorized',
    );
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  try {
    const result = await runPruneOrphanedZeroRateCerts({});

    // Tenant-list failure → 500 so cron-job.org surfaces a sustained outage
    // (the discriminated outcome makes scan_failed disjoint from the counters).
    if (result.kind === 'scan_failed') {
      return NextResponse.json(
        { error: { code: 'scan_failed' }, requestId },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        scanned: result.scanned,
        swept: result.swept,
        skipped: result.skipped,
        cutoff: result.cutoff.toISOString(),
        requestId,
      },
      { status: 200 },
    );
  } catch (e) {
    logger.error(
      {
        requestId,
        route: ROUTE,
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
      },
      'cron.prune_orphaned_zero_rate_certs.threw',
    );
    return NextResponse.json(
      { error: { code: 'scan_failed' }, requestId },
      { status: 500 },
    );
  }
}
