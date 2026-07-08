/**
 * Phase 3 of the F4 receipt-surface plan — GET
 * `/api/admin/invoices/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 *
 * Admin-only (manager + member → 404). Streams a CSV of every paid
 * invoice whose `paidAt` (Bangkok-local YYYY-MM-DD) falls inside the
 * inclusive range. The CSV is encoded UTF-8 with a leading BOM so
 * Excel-TH renders Thai legal names without forcing the import wizard.
 *
 * Audit: `invoices_csv_exported` (5y retention) emitted by the
 * use-case on success.
 *
 * Plan reference: `.claude/plans/jolly-shimmying-sundae.md`
 *   § "Phase 3 — CSV Export of paid invoices".
 *
 * Node runtime pinned (Drizzle).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';
import { logger } from '@/lib/logger';
import {
  exportPaidInvoicesCsv,
  makeExportPaidInvoicesCsvDeps,
} from '@/modules/invoicing';

export const runtime = 'nodejs';

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest): Promise<Response> {
  // 1. RBAC — admin only. Manager/member/anonymous rejections are
  //    forwarded as-is from requireAdminContext (401 anonymous /
  //    403 wrong-role).
  const ctx = await requireAdminContext(request, {
    resource: 'invoice',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  // 2. Query-param parse + shape check. The use-case schema does
  //    range-semantics validation; this layer does the format probe
  //    so a malformed `from=` doesn't waste a use-case dispatch.
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (!from || !to || !YMD_PATTERN.test(from) || !YMD_PATTERN.test(to)) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_range_format',
          message: '`from` and `to` query params must be `YYYY-MM-DD`.',
        },
      },
      { status: 400 },
    );
  }

  // 3. Tenant + actor wiring.
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // 4. Dispatch use-case.
  const result = await exportPaidInvoicesCsv(
    makeExportPaidInvoicesCsvDeps(tenantCtx.slug),
    {
      tenantId: tenantCtx.slug,
      actorUserId: ctx.current.user.id,
      from,
      to,
      requestId,
    },
  );

  if (!result.ok) {
    if (result.error.code === 'invalid_range') {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_range',
            reason: result.error.reason,
            message:
              result.error.reason === 'inverted'
                ? '`from` must be ≤ `to`.'
                : 'Range exceeds the 1-year maximum.',
          },
        },
        { status: 400 },
      );
    }
    logger.error(
      { tenantSlug: tenantCtx.slug, requestId, err: result.error },
      '[admin-invoices-csv] export use-case failed',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }

  // 5. Stream the CSV. The body is small (chamber scale ~1.3k rows
  //    × 12 columns ≈ <200KB) so a single `text/csv` response is
  //    fine — no chunked streaming yet. Future tenants with 10k+
  //    rows/month: switch to a ReadableStream and remove the
  //    in-memory buffer (`exportPaidInvoicesCsv` is the right
  //    place to introduce a row-iterator port).
  return new NextResponse(result.value.csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': buildAttachmentContentDisposition(
        result.value.filename,
      ),
      // Match other F4 download routes: never cache + immediate
      // download trigger.
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      // Useful for the dialog's post-submit toast.
      'X-Row-Count': String(result.value.rowCount),
    },
  });
}
