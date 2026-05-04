/**
 * F8 Phase 3 Wave H3 · T066 — POST `/api/admin/renewals/[cycleId]/mark-paid-offline`.
 *
 * Admin-only out-of-band payment per `contracts/admin-renewals-api.md` § 2.
 * Manager 403 emits `f8_role_violation_blocked` audit (verify-run C1).
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { markPaidOffline, makeRenewalsDeps } from '@/modules/renewals';

/**
 * Round 5 W-01 — Reject `payment_reference` strings that contain a
 * 13–19-digit run (the standard PAN length range). F8 mark-paid-offline
 * is for bank-transfer / cash / cheque references — there is no
 * legitimate reason to paste a card number here, and `payment_reference`
 * is persisted verbatim in `audit_log.payload`. Defence-in-depth against
 * accidental PCI-scope expansion via operator paste error. Embedded
 * spaces between digit groups still trigger the regex via the `[\s-]?`
 * tolerance (`4111 1111 1111 1111` → 16 digits matched).
 */
const PAN_LIKE_RE = /(?:\d[\s-]?){13,19}/;

const BodySchema = z.object({
  payment_method: z.enum(['bank_transfer', 'cash', 'cheque']),
  payment_reference: z
    .string()
    .min(1)
    .max(100)
    .refine((v) => !PAN_LIKE_RE.test(v), {
      message:
        'payment_reference contains a digit sequence that resembles a card number — F8 stores this field verbatim in the audit trail; refuse to persist',
    }),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ cycleId: string }> },
) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'write');
  if ('response' in ctx) return ctx.response;

  const { cycleId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
    });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await markPaidOffline(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
      paymentMethod: parsed.data.payment_method,
      paymentReference: parsed.data.payment_reference,
      paymentDate: parsed.data.payment_date,
      actorUserId: ctx.current.user.id,
      actorRole: 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'cycle_not_found':
          return errorResponse({
            status: 404,
            code: 'cycle_not_found',
            correlationId: ctx.correlationId,
          });
        case 'cycle_not_payable':
          return errorResponse({
            status: 409,
            code: 'cycle_not_payable',
            correlationId: ctx.correlationId,
            details: { current_status: result.error.currentStatus },
          });
        case 'f4_failure':
          // Round 5 W-02 — log the F4 internal `reason` server-side
          // for ops triage but do NOT echo it to the client. F4's
          // reason can include schema/column names and partial row
          // data which would leak into the admin UI.
          logger.warn(
            {
              correlationId: ctx.correlationId,
              cycleId,
              tenantId: tenantCtx.slug,
              f4Stage: result.error.stage,
              f4Reason: result.error.reason,
            },
            'mark-paid-offline: F4 chain failed (reason scrubbed from HTTP response)',
          );
          return errorResponse({
            status: 502,
            code: 'f4_failure',
            correlationId: ctx.correlationId,
            details: {
              stage: result.error.stage,
            },
          });
        case 'f4_orphan_invoice':
          // 409 (conflict) — admin must resume from F4 invoice list.
          // The error envelope carries the orphan invoice id so the UI
          // can deep-link "View invoice" + show DO-NOT-RETRY guidance.
          // Round 5 W-02 — same reason-scrubbing rationale as
          // f4_failure above.
          logger.warn(
            {
              correlationId: ctx.correlationId,
              cycleId,
              tenantId: tenantCtx.slug,
              orphanInvoiceId: result.error.orphanInvoiceId,
              f4Reason: result.error.reason,
            },
            'mark-paid-offline: F4 orphan invoice (reason scrubbed from HTTP response)',
          );
          return errorResponse({
            status: 409,
            code: 'f4_orphan_invoice',
            correlationId: ctx.correlationId,
            details: {
              orphan_invoice_id: result.error.orphanInvoiceId,
            },
          });
      }
    }
    return successResponse(
      {
        cycle_status: result.value.cycleStatus,
        invoice_id: result.value.invoiceId,
        new_expires_at: result.value.newExpiresAt,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId: ctx.correlationId,
        cycleId,
        tenantId: tenantCtx.slug,
      },
      'mark-paid-offline route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
