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
 * Round 5 W-01 / Round 6 B-R5-1+W-R5-4 / Round 7 B-R6-2 — Reject
 * `payment_reference` strings that contain 13+ CONSECUTIVE digits
 * (PAN paste-error guard). F8 mark-paid-offline is for bank-transfer /
 * cash / cheque references — there is no legitimate reason to paste a
 * raw card number here, and `payment_reference` is persisted verbatim
 * in `audit_log.payload`. Defence-in-depth against accidental
 * PCI-scope expansion (Constitution Principle IV NON-NEGOTIABLE).
 *
 * Detection passes (a value is rejected if EITHER pass matches):
 *
 *   1. **ASCII fast-path**: `\d{13,}` after NFKD-decompose +
 *      non-ASCII strip. Catches the dominant raw-paste error
 *      pattern (e.g. `4111111111111111`).
 *
 *   2. **Round 7 B-R6-2 — Unicode digit fallback**: NFKD does NOT
 *      decompose Arabic-Indic (`٠-٩`, U+0660-U+0669), Eastern
 *      Arabic-Indic (`۰-۹`, U+06F0-U+06F9), Devanagari
 *      (`०-९`, U+0966-U+096F), or Thai (`๐-๙`, U+0E50-U+0E59) digits
 *      — they remain at their original codepoints. The non-ASCII
 *      strip in pass 1 then removes them ENTIRELY, leaving a string
 *      `\d{13,}` cannot match. Round 6 review surfaced this as a PCI
 *      bypass: `'٤١١١١١١١١١١١١١١١'` (16 Arabic-Indic) was silently
 *      accepted. Pass 2 tests the original `raw` string with the
 *      `/u` flag enabled and an explicit script-digit character
 *      class so the four most likely substitution scripts are caught.
 *
 * Allowed (intentional trade-offs — Round 7 W-R6-2 + S-R6-4):
 *   - Thai bank reference `YYYYMMDD-NNNNN` (max ASCII run 8) —
 *     legitimate operator workflow.
 *   - Manually-formatted PAN with spaces OR hyphens between groups —
 *     `4111 1111 1111 1111` / `4111-1111-1111-1111` (max consecutive
 *     run 4 digits). NFKD does NOT decompose ASCII hyphens (U+002D
 *     has no decomposition), so the non-ASCII strip leaves them in
 *     place; both separators result in the same max-run-4 outcome.
 *     Both are rare paste-error patterns at the F8 surface; the
 *     operator workflow surfaces the value in the confirmation toast
 *     before submission as second line of defence. Coverage explicitly
 *     documented in admin-mark-paid-offline-route.test.ts so the gap
 *     is visible to future reviewers (not buried in this comment).
 *     Tracked as Phase 3.5 if real-world incidents require tighter
 *     coverage.
 */
const PAN_LIKE_ASCII_RE = /\d{13,}/;
// Pass 2: covers script-digit blocks NFKD does NOT decompose to ASCII.
// Round 8 W-R7-3 added `\u{1D7CE}-\u{1D7D7}` Mathematical Bold Digits
// (`𝟎-𝟗`, U+1D7CE-U+1D7D7) — 4-byte codepoints in the SMP
// (Supplementary Multilingual Plane). The `/u` flag is now load-bearing
// for surrogate-pair handling on these codepoints. Mathematical Bold
// is a realistic operator-paste vector via rich-text editors and
// spreadsheet copy-paste.
//
// Accepted-deferred (low realistic-vector for Thai chamber operator
// context): Bengali (U+09E6-U+09EF), Tamil (U+0BE6-U+0BEF), Khmer
// (U+17E0-U+17E9), Lao (U+0ED0-U+0ED9), Myanmar (U+1040-U+1049),
// Tibetan (U+0F20-U+0F29). Tracked as Phase 3.5 if real-world
// incidents require coverage.
const PAN_LIKE_UNICODE_DIGITS_RE =
  /[٠-٩۰-۹०-९๐-๙\u{1D7CE}-\u{1D7D7}]{13,}/u;

function isPanLikeReference(raw: string): boolean {
  // Pass 1 — ASCII PAN after NFKD + non-ASCII strip.
  const normalised = raw.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  if (PAN_LIKE_ASCII_RE.test(normalised)) return true;
  // Pass 2 — Unicode script-digit substitutes on the ORIGINAL raw input
  // (NFKD-stripped form has already lost them).
  return PAN_LIKE_UNICODE_DIGITS_RE.test(raw);
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
          // Round 8 B-R7-1 — drop `stage` from HTTP body. Round 7 W-R6-4
          // added `f4Stage` to REDACT_PATHS (log path protected) but
          // pino redaction does NOT apply to `NextResponse.json` —
          // the stage names embed F4 internal use-case identifiers
          // and would leak to admin UI + APM middleware capturing
          // response bodies. Operators have `correlationId` + the
          // server-side `logger.warn` line for support triage.
          return errorResponse({
            status: 502,
            code: 'f4_failure',
            correlationId: ctx.correlationId,
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
        case 'server_error':
          // K1-C7: server_error variant from Application use-case body.
          // Already logged with full stack inside markPaidOffline; here
          // we surface a generic 500 (no message echo to avoid leaking
          // F4 internals to admin UI).
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          // K1-E1: exhaustiveness pin. Adding a new MarkPaidOfflineError
          // variant now produces a TS error rather than silently 200ing
          // with `undefined` value.
          const _exhaustive: never = result.error;
          void _exhaustive;
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        }
      }
    }
    const response: Record<string, unknown> = {
      // Task 7 (rolling-anchor refactor) — discriminates the
      // 'completed' vs 'reanchored' shared-classifier branch so the
      // admin UI can show branch-specific copy without re-deriving it.
      outcome: result.value.outcome,
      cycle_status: result.value.cycleStatus,
      invoice_id: result.value.invoiceId,
      new_expires_at: result.value.newExpiresAt,
    };
    // RRA task 7 fix — include true period start for reanchored toast.
    if (result.value.outcome === 'reanchored') {
      response.new_period_from = result.value.newPeriodFrom;
    }
    return successResponse(response, ctx.correlationId);
  } catch (e) {
    logger.error(
      {
        // K12-3 (REL-K-1): pass the Error instance so pino's `err`
        // serializer captures stack + type.
        err: e instanceof Error ? e : new Error(String(e)),
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
