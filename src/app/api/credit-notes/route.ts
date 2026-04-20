/**
 * T080 — POST /api/credit-notes (F4 / US6).
 *
 * Issues a credit note against a paid or partially-credited invoice.
 * Admin-only. Rate-limited 20/5min per (tenant, actor) mirroring
 * issue-invoice / pay — the partial-accumulation lock is the safety
 * net for legitimate retries; this cap throttles misbehaving clients
 * before they hit the DB.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  issueCreditNote,
  issueCreditNoteSchema,
  makeIssueCreditNoteDeps,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';
import { stripReason } from '../invoices/_serialise';
import { serialiseCreditNote } from './_serialise';
import type { IssueCreditNoteError } from '@/modules/invoicing';

// SG-7 — error-code → HTTP status lookup. Cleaner than a nested
// ternary chain and easier to extend when new typed errors land.
// Any future addition to `IssueCreditNoteError` that isn't listed
// here falls through to HTTP 422 (see the `?? 422` below).
const ERROR_STATUS: Record<IssueCreditNoteError['code'], number> = {
  invoice_not_found: 404,
  invalid_status: 409,
  concurrent_state_change: 409,
  credit_exceeds_remainder: 409,
  settings_missing: 422,
  no_snapshot_on_invoice: 422,
  overflow: 422,
  pdf_render_failed: 500,
  blob_upload_failed: 500,
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'credit_note',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;
  // Manager role is read-only on finance per Constitution §.
  if (ctx.current.user.role !== 'admin') {
    return NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  const rl = await rateLimiter.check(
    `f4:credit-note:${tenantCtx.slug}:${ctx.current.user.id}`,
    20,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/credit-notes rate-limited',
    );
    return NextResponse.json(
      { error: { code: 'rate_limited', retryAfterMs: rl.reset - Date.now() } },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.reset - Date.now()) / 1000)) },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'invalid_json' } }, { status: 400 });
  }

  // Coerce creditTotalSatang from JSON string → bigint. JSON can't
  // carry native bigint so the client sends a decimal string; zod's
  // `z.bigint()` accepts a BigInt at parse time so we convert here.
  const rawBody = (body as Record<string, unknown>) ?? {};
  let creditTotalSatang: bigint | null = null;
  if (typeof rawBody.creditTotalSatang === 'string') {
    try {
      creditTotalSatang = BigInt(rawBody.creditTotalSatang);
    } catch {
      return NextResponse.json(
        { error: { code: 'invalid_body', details: 'creditTotalSatang must be a numeric string' } },
        { status: 400 },
      );
    }
  }

  const parsed = issueCreditNoteSchema.safeParse({
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    invoiceId: rawBody.invoiceId,
    creditTotalSatang,
    reason: rawBody.reason,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_body', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  const result = await issueCreditNote(
    makeIssueCreditNoteDeps(tenantCtx.slug),
    parsed.data,
  );
  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId: parsed.data.invoiceId,
        errorCode: result.error.code,
      },
      'POST /api/credit-notes failed',
    );
    const status = ERROR_STATUS[result.error.code] ?? 422;
    // `credit_exceeds_remainder` carries bigints — coerce to strings
    // so JSON.stringify doesn't throw. Other errors pass through the
    // shared stripReason helper which already tolerates plain codes.
    if (result.error.code === 'credit_exceeds_remainder') {
      return NextResponse.json(
        {
          error: {
            code: result.error.code,
            invoiceTotalSatang: result.error.invoiceTotalSatang.toString(),
            alreadyCreditedSatang: result.error.alreadyCreditedSatang.toString(),
            proposedSatang: result.error.proposedSatang.toString(),
            remainingSatang: result.error.remainingSatang.toString(),
          },
        },
        { status },
      );
    }
    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }
  return NextResponse.json(serialiseCreditNote(result.value), { status: 201 });
}
