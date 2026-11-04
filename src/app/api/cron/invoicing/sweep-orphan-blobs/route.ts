/**
 * GET/POST `/api/cron/invoicing/sweep-orphan-blobs` — #729 (task 63).
 *
 * The daily reclaim of invoicing Blob orphans, in one scheduled route (the
 * Pro plan holds 40 crons):
 *   1. the zero-rate certificate prune (`runPruneOrphanedZeroRateCerts`,
 *      088 T061f — its own route stays for a manual run);
 *   2. the orphan PDF sweep (`runSweepOrphanPdfs`): invoice, receipt and
 *      credit-note PDFs no row references. The rule lives in
 *      `src/modules/invoicing/application/use-cases/sweep-orphan-pdfs.ts`.
 * Each half runs even when the other fails; either failing answers 500.
 * The cert prune runs on production only (it has no dry run).
 *
 * Delete gate: the PDF sweep deletes only on a production deployment with
 * `FEATURE_ORPHAN_PDF_SWEEP_DELETE` on, and is a dry run anywhere else. A
 * preview's Neon branch can lag the Blob store it shares a token with, so a
 * real delete there could remove a live document's PDF. `?dryRun=1` asks for
 * a PDF dry run and skips the cert prune (which has no dry run).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`. Returns 200 with counts (no
 * PII, no keys), 401, or 500 `scan_failed`. Thin route: no deep
 * `@/modules/invoicing/*` imports. Runbook: `docs/runbooks/cron-jobs.md`
 * § sweep-orphan-blobs.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronBearer } from '@/lib/cron-auth';
import { cronReadOnlyGuard } from '@/lib/cron-read-only-guard';
import { env } from '@/lib/env';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { runPruneOrphanedZeroRateCerts } from '@/lib/invoicing-cert-prune-deps';
import { runSweepOrphanPdfs } from '@/lib/invoicing-orphan-pdf-sweep-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = '/api/cron/invoicing/sweep-orphan-blobs';
/** Work budget for both halves; the rest of maxDuration is headroom. */
const BUDGET_MS = 240_000;

// Vercel Cron calls with GET; one handler serves both.
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const startedAt = Date.now();

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId, route: ROUTE }, 'cron.sweep_orphan_blobs.unauthorized');
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  // #408 — READ_ONLY_MODE: the proxy freeze does not cover GET, so skip here.
  const frozen = cronReadOnlyGuard(ROUTE);
  if (frozen) return frozen;

  const askedDryRun = request.nextUrl?.searchParams.get('dryRun') === '1';
  const gateOpen = env.features.orphanPdfSweepDelete && env.vercelEnv === 'production';
  const pdfDryRun = askedDryRun || !gateOpen;
  // Whether THIS run's PDF sweep deletes.
  const deletesEnabled = !pdfDryRun;

  // 1. Zero-rate certificate prune.
  let certs: Record<string, unknown>;
  let failed = false;
  if (askedDryRun) {
    certs = { skipped: 'dry_run' };
  } else if (env.vercelEnv !== 'production') {
    // No dry run exists for the prune, and a non-production deployment (or a
    // local machine) can hold a token for production's store with another
    // branch's pins (R126 F2): it deletes nothing there.
    certs = { skipped: 'not_production' };
  } else {
    try {
      const r = await runPruneOrphanedZeroRateCerts({});
      if (r.kind === 'scan_failed') {
        failed = true;
        certs = { scanFailed: true };
      } else {
        certs = { scanned: r.scanned, swept: r.swept, skipped: r.skipped, cutoff: r.cutoff.toISOString() };
      }
    } catch (e) {
      failed = true;
      certs = { scanFailed: true };
      logger.error({ requestId, route: ROUTE, step: 'certs', err: errKind(e) }, 'cron.sweep_orphan_blobs.threw');
    }
  }

  // 2. Orphan PDF sweep, in what is left of the budget.
  let pdfs: Record<string, unknown>;
  try {
    const r = await runSweepOrphanPdfs({
      dryRun: pdfDryRun,
      deadlineMs: Math.max(0, BUDGET_MS - (Date.now() - startedAt)),
    });
    if (r.kind === 'scan_failed') {
      failed = true;
      pdfs = { scanFailed: true };
    } else {
      const { kind: _kind, ...counts } = r;
      pdfs = counts;
    }
  } catch (e) {
    failed = true;
    pdfs = { scanFailed: true };
    logger.error({ requestId, route: ROUTE, step: 'pdfs', err: errKind(e) }, 'cron.sweep_orphan_blobs.threw');
  }

  if (failed) {
    return NextResponse.json({ error: { code: 'scan_failed' }, deletesEnabled, certs, pdfs, requestId }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deletesEnabled, certs, pdfs, requestId }, { status: 200 });
}
