/**
 * GET/POST `/api/cron/invoicing/sweep-orphan-pdfs` — #729 (task 63).
 *
 * Daily reclaim of invoice, receipt and credit-note PDFs that no row
 * references: bytes a killed function, a rolled-back caller transaction, a
 * void-instead-of-retry or a template bump left at a deterministic key. A key
 * is kept iff the row it names references exactly that key (re-checked under
 * the invoice row lock); only keys at least an hour old are looked at. The
 * rule lives in `src/modules/invoicing/application/use-cases/sweep-orphan-pdfs.ts`.
 *
 * `?dryRun=1` reports what would be deleted and deletes nothing (use it
 * before the first real run on a new environment).
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`. Not feature-gated. Returns
 * 200 with counts (no PII), 401, or 500 `scan_failed`. Thin route: no deep
 * `@/modules/invoicing/*` imports. Runbook: `docs/runbooks/cron-jobs.md`
 * § sweep-orphan-pdfs.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronBearer } from '@/lib/cron-auth';
import { cronReadOnlyGuard } from '@/lib/cron-read-only-guard';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { runSweepOrphanPdfs } from '@/lib/invoicing-orphan-pdf-sweep-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = '/api/cron/invoicing/sweep-orphan-pdfs';

// Vercel Cron calls with GET; one handler serves both.
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId, route: ROUTE }, 'cron.sweep_orphan_pdfs.unauthorized');
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  // #408 — READ_ONLY_MODE: the proxy freeze does not cover GET, so skip here.
  const frozen = cronReadOnlyGuard(ROUTE);
  if (frozen) return frozen;

  const dryRun = request.nextUrl?.searchParams.get('dryRun') === '1';
  try {
    const result = await runSweepOrphanPdfs({ dryRun });
    if (result.kind === 'scan_failed') {
      return NextResponse.json({ error: { code: 'scan_failed' }, requestId }, { status: 500 });
    }
    const { kind: _kind, ...counts } = result;
    return NextResponse.json({ ok: true, ...counts, requestId }, { status: 200 });
  } catch (e) {
    logger.error(
      { requestId, route: ROUTE, errKind: e instanceof Error ? e.constructor.name : 'unknown' },
      'cron.sweep_orphan_pdfs.threw',
    );
    return NextResponse.json({ error: { code: 'scan_failed' }, requestId }, { status: 500 });
  }
}
