/**
 * CF-2 — POST /api/refunds/resolve-auto-refund-failure.
 *
 * Admin-only "mark a failed stale-invoice auto-refund as manually reconciled"
 * surface. Mirrors the shape of `/api/refunds/initiate` (admin RBAC, F5 headers,
 * bilingual error envelope) but does NO Stripe / money movement — it appends the
 * append-only `auto_refund_reconciled` audit event via the
 * `resolveFailedAutoRefund` use-case, which clears the persistent
 * `AutoRefundFailedAlert` + reverts the member void banner.
 *
 * Auth: `requireAdminContext({ resource: 'refund', action: 'write' })` — the
 * same admin-only gate the refund-initiate route uses (manager → 403).
 *
 * PCI (Principle IV): logs + audit carry ids only — no card data, no raw
 * `error.message`. The 500 path emits a bounded `errKind` classifier.
 *
 * Runtime: Node.js (matches the F5 route baseline).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { logger } from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import {
  resolveFailedAutoRefund,
  makeResolveFailedAutoRefundDeps,
} from '@/modules/payments';
import { baseHeaders, errorResponse } from '@/lib/payments-route-helpers';
import { errKind } from '@/lib/log-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `note` blocks CR/LF so it renders cleanly in the audit log without forcing
// downstream consumers to escape newlines (mirrors refund `reason`).
const NOTE_NO_NEWLINE_RE = /^[^\r\n]+$/;
const ResolveBody = z.object({
  // The invoice id is an application id (uuid-ish); bound generously — the
  // use-case's audit read simply finds nothing for a nonexistent id → 409.
  invoiceId: z.string().min(1).max(200),
  note: z
    .string()
    .min(1)
    .max(500)
    .regex(NOTE_NO_NEWLINE_RE, 'note must be a single line')
    .optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const correlationId = randomUUID();

  // Admin-only, same RBAC gate as refund-initiate (manager → 403).
  const adminCtx = await requireAdminContext(request, {
    resource: 'refund',
    action: 'write',
  });
  if ('response' in adminCtx && adminCtx.response) {
    return adminCtx.response as NextResponse;
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const actorUserId = adminCtx.current.user.id;

  // 30/5min per (tenant, actor) — comfortably above any human cadence for a
  // rare admin action; defends a stuck client from hammering the audit rail.
  const rl = await rateLimiter.check(
    `refunds.resolve:${tenantCtx.slug}:${actorUserId}`,
    30,
    300,
  );
  if (!rl.success) {
    const retryAfterSeconds = retryAfterSecondsFromRl(rl);
    logger.warn(
      { tenantId: tenantCtx.slug, userId: actorUserId, requestId, correlationId, reset: rl.reset },
      'refunds.resolve.rate_limited',
    );
    return errorResponse(429, 'rate_limited', correlationId, { retryAfterSeconds });
  }

  let parsedBody: z.infer<typeof ResolveBody>;
  try {
    const json = (await request.json()) as unknown;
    const result = ResolveBody.safeParse(json);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.');
        (fieldErrors[path] ??= []).push(issue.message);
      }
      return errorResponse(400, 'invalid_input', correlationId, { fieldErrors });
    }
    parsedBody = result.data;
  } catch {
    return errorResponse(400, 'invalid_input', correlationId);
  }

  try {
    const deps = makeResolveFailedAutoRefundDeps(tenantCtx.slug);
    const result = await resolveFailedAutoRefund(deps, {
      tenantId: tenantCtx.slug,
      invoiceId: parsedBody.invoiceId,
      actorUserId,
      requestId,
      ...(parsedBody.note !== undefined ? { note: parsedBody.note } : {}),
    });

    if (result.ok) {
      // Both `reconciled` and `already_reconciled` are 200 — the second is the
      // idempotent benign no-op (a concurrent admin already acknowledged).
      return NextResponse.json(
        { outcome: result.value.kind, correlationId },
        { status: 200, headers: baseHeaders(correlationId) },
      );
    }

    if (result.error.code === 'no_failed_auto_refund') {
      logger.warn(
        { tenantId: tenantCtx.slug, userId: actorUserId, requestId, correlationId },
        'refunds.resolve.no_failed_auto_refund',
      );
      return errorResponse(409, 'no_failed_auto_refund', correlationId);
    }

    // internal_error — never surface the caught cause.
    logger.error(
      {
        errKind: errKind(result.error.cause),
        tenantId: tenantCtx.slug,
        userId: actorUserId,
        requestId,
        correlationId,
      },
      'refunds.resolve.use_case_internal_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  } catch (e) {
    logger.error(
      {
        errKind: errKind(e),
        tenantId: tenantCtx.slug,
        userId: actorUserId,
        requestId,
        correlationId,
      },
      'refunds.resolve.unexpected_throw',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
