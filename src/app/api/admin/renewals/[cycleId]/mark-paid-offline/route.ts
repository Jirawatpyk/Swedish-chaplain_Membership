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
 * Round 5 W-01 / Round 6 B-R5-1+W-R5-4 — Reject `payment_reference`
 * strings that contain 13+ CONSECUTIVE digits (PAN paste-error guard).
 * F8 mark-paid-offline is for bank-transfer / cash / cheque references
 * — there is no legitimate reason to paste a raw card number here, and
 * `payment_reference` is persisted verbatim in `audit_log.payload`.
 * Defence-in-depth against accidental PCI-scope expansion.
 *
 * Round 6 design rationale (replaces Round 5's flawed `(\d[\s-]?){13,19}`
 * which counted "digit + optional separator" repetitions and falsely
 * blocked standard Thai bank reference format `YYYYMMDD-NNNNN`):
 *
 *   - **Block**: ≥13 ASCII digits in a row (e.g. raw paste of
 *     `4111111111111111`). This is the dominant operator-paste-error
 *     pattern — operators rarely paste card numbers with manual
 *     spaces, since most card-storage UIs render the PAN as a single
 *     digit run.
 *   - **Allow**: Thai bank reference `YYYYMMDD-NNNNN` (max run of 8
 *     consecutive digits between hyphens), prefixed variants
 *     `KTB-20260504-12345`, `SCB-TT-20260504-00042`, etc.
 *   - **Trade-off accepted**: a manually-spaced PAN
 *     `4111 1111 1111 1111` slips through (max run 4 digits). This is
 *     a rare paste-error pattern and the operator workflow surfaces
 *     the value back in the confirmation toast before submission.
 *
 * W-R5-4 Unicode handling: NFKD-decompose then strip non-ASCII BEFORE
 * the regex test so Arabic-Indic (٠-٩), Devanagari (०-९), or Thai
 * (๐-๙) digit substitutes cannot bypass `\d` (which is `[0-9]` only
 * without `/u` flag).
 */
const PAN_LIKE_RE = /\d{13,}/;

function isPanLikeReference(raw: string): boolean {
  const normalised = raw.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  return PAN_LIKE_RE.test(normalised);
}

const BodySchema = z.object({
  payment_method: z.enum(['bank_transfer', 'cash', 'cheque']),
  payment_reference: z
    .string()
    .min(1)
    .max(100)
    .refine((v) => !isPanLikeReference(v), {
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
