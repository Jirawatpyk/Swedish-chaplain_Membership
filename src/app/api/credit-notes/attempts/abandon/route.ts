/**
 * Task 68 — POST /api/credit-notes/attempts/abandon: "Start over" on a locked
 * admin credit-note attempt.
 *
 * Body `{ invoiceId, idempotencyKey }` (both uuid). Same gate and rate-limit
 * bucket as issuing a note: closing an attempt decides whether a §86/10 note
 * will exist. Answers `200 { outcome: 'abandoned' }` (the key is closed for
 * good) or `200 { outcome: 'issued', ...serialised note }` (the attempt had
 * already issued it). The decision is made under the invoice lock by
 * `abandonCreditNoteAttempt`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  abandonCreditNoteAttempt,
  abandonCreditNoteAttemptSchema,
  makeAbandonCreditNoteAttemptDeps,
  type AbandonCreditNoteAttemptError,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';
import { serialiseCreditNote } from '../../_serialise';

const ERROR_STATUS: Record<AbandonCreditNoteAttemptError['code'], number> = {
  invoice_not_found: 404,
  concurrent_state_change: 409,
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireApiPermission(request, 'credit_notes.write');
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // The issue route's bucket: Start over and issuing share one budget.
  const rl = await rateLimiter.check(`f4:credit-note:${tenantCtx.slug}:${ctx.current.user.id}`, 20, 300);
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/credit-notes/attempts/abandon rate-limited',
    );
    return rateLimitedJson(rl);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'invalid_json' } }, { status: 400 });
  }
  const rawBody = (body as Record<string, unknown>) ?? {};
  const parsed = abandonCreditNoteAttemptSchema.safeParse({
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    invoiceId: rawBody.invoiceId,
    idempotencyKey: rawBody.idempotencyKey,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_body', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  const result = await abandonCreditNoteAttempt(makeAbandonCreditNoteAttemptDeps(tenantCtx.slug), parsed.data);
  if (!result.ok) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, invoiceId: parsed.data.invoiceId, errorCode: result.error.code },
      'POST /api/credit-notes/attempts/abandon refused',
    );
    return NextResponse.json({ error: { code: result.error.code } }, { status: ERROR_STATUS[result.error.code] });
  }
  if (result.value.outcome === 'issued') {
    return NextResponse.json(
      { outcome: 'issued', ...serialiseCreditNote(result.value.creditNote) },
      { status: 200 },
    );
  }
  return NextResponse.json({ outcome: 'abandoned' }, { status: 200 });
}
