/**
 * Spec 122 US8b follow-up — GET /api/refunds/credit-note-preview.
 *
 * The refund dialog's "Credit note to be issued" rows (boards
 * `Admin-refund-full`, `Admin-refund-partial`): the amount excl. VAT and the
 * VAT of the §86/10 ใบลดหนี้ a refund of `amountSatang` would issue, or no
 * credit note at all when F4 waives it (a §105 receipt, a voided invoice) or
 * the gate blocks the refund. The split is F4's proportional credit-note VAT
 * policy, computed here so the browser never does VAT arithmetic.
 *
 * A READ: no write, no money moves. The only audit row is the cross-tenant
 * probe, when the invoice id is not in this tenant. The refund itself still
 * goes through POST /api/refunds/initiate, which re-derives everything.
 *
 *   - Auth: `refunds.write`, the refund's own permission (manager → 403).
 *   - Rate limit: 120 / 5 min per (tenant, actor), its own bucket so typing
 *     an amount never spends the refund's 20 / 5 min.
 *   - F5 envelope: `Cache-Control: no-store, private`, `X-Correlation-Id`,
 *     bilingual error messages; satang as decimal strings.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { baseHeaders, errorResponse } from '@/lib/payments-route-helpers';
import { makePreviewRefundCreditNoteDeps, previewRefundCreditNote } from '@/modules/invoicing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same cap as POST /api/refunds/initiate.
const AMOUNT_SATANG_MAX = 2_000_000_000n;

const PreviewQuery = z.object({
  invoiceId: z.string().uuid(),
  amountSatang: z
    .string()
    .regex(/^\d+$/, 'amountSatang must be a positive integer string')
    .transform((v) => BigInt(v))
    .refine((v) => v > 0n && v <= AMOUNT_SATANG_MAX, {
      message: `amountSatang must be > 0 and ≤ ${AMOUNT_SATANG_MAX}`,
    }),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const correlationId = randomUUID();

  const adminCtx = await requireApiPermission(request, 'refunds.write');
  if ('response' in adminCtx && adminCtx.response) {
    return adminCtx.response as NextResponse;
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const actorUserId = adminCtx.current.user.id;

  const rl = await rateLimiter.check(
    `refunds.credit_note_preview:${tenantCtx.slug}:${actorUserId}`,
    120,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { tenantId: tenantCtx.slug, userId: actorUserId, requestId, correlationId, reset: rl.reset },
      'refunds.credit_note_preview.rate_limited',
    );
    return errorResponse(429, 'rate_limited', correlationId, {
      retryAfterSeconds: retryAfterSecondsFromRl(rl),
    });
  }

  const parsed = PreviewQuery.safeParse({
    invoiceId: request.nextUrl.searchParams.get('invoiceId') ?? undefined,
    amountSatang: request.nextUrl.searchParams.get('amountSatang') ?? undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      (fieldErrors[issue.path.join('.')] ??= []).push(issue.message);
    }
    return errorResponse(400, 'invalid_input', correlationId, { fieldErrors });
  }
  const { invoiceId, amountSatang } = parsed.data;

  let result: Awaited<ReturnType<typeof previewRefundCreditNote>>;
  try {
    result = await previewRefundCreditNote(makePreviewRefundCreditNoteDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug,
      invoiceId,
      creditTotalSatang: amountSatang,
      actor: { userId: actorUserId, role: adminCtx.current.user.role, requestId },
    });
  } catch (e) {
    logger.error(
      { err: errKind(e), tenantId: tenantCtx.slug, invoiceId, requestId, correlationId },
      'refunds.credit_note_preview.failed',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }

  if (!result.ok) {
    const error = result.error;
    switch (error.code) {
      case 'not_found':
        return errorResponse(404, 'invoice_not_accessible', correlationId);
      case 'exceeds_remainder':
        return errorResponse(409, 'refund_exceeds_remaining', correlationId, {
          remainingSatang: error.remainingSatang.toString(),
        });
      case 'invoice_data_corrupt':
        logger.error(
          { tenantId: tenantCtx.slug, invoiceId, requestId, correlationId },
          'refunds.credit_note_preview.invoice_data_corrupt',
        );
        return errorResponse(422, 'invoice_data_corrupt', correlationId);
      default: {
        const _exhaustive: never = error;
        void _exhaustive;
        return errorResponse(500, 'internal_error', correlationId);
      }
    }
  }

  const preview = result.value;
  const creditNote =
    preview.kind === 'issue'
      ? {
          kind: 'issue' as const,
          netSatang: preview.netSatang.toString(),
          vatSatang: preview.vatSatang.toString(),
          vatRate: preview.vatRateRaw,
        }
      : preview;

  return NextResponse.json(
    { creditNote, correlationId },
    { status: 200, headers: baseHeaders(correlationId) },
  );
}
