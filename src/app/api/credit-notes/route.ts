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
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';
import { cancelInFlightCyclesForMember, makeRenewalsDeps } from '@/modules/renewals';
import { asMemberId } from '@/modules/members';
import { stripReason } from '../invoices/_serialise';
import { serialiseCreditNote } from './_serialise';
import type {
  IssueCreditNoteError,
  CreditNoteEmailDelivery,
} from '@/modules/invoicing';

// FIX 8 (Round-2 code-review) — explicit 201 body type. The serialised
// credit-note fields are spread, then `email_delivery` rides as a sibling
// (MEDIUM-5). Without an explicit type a FUTURE `email_delivery` field on
// `serialiseCreditNote` would SILENTLY collide (the sibling would shadow it).
// The guard below turns that into a compile error.
type SerialisedCreditNote = ReturnType<typeof serialiseCreditNote>;

// Compile-time guard: `serialiseCreditNote` MUST NOT itself declare an
// `email_delivery` key — it would collide with the route's sibling field.
// `HasEmailDeliveryKey` is `true` iff the serialiser grows such a key; the
// const below is typed `false`, so a collision fails `tsc` here.
type HasEmailDeliveryKey = 'email_delivery' extends keyof SerialisedCreditNote
  ? true
  : false;
const _assertNoEmailDeliveryCollision: false = false as HasEmailDeliveryKey;

interface CreditNoteResponseBody extends SerialisedCreditNote {
  readonly email_delivery: CreditNoteEmailDelivery;
  /**
   * F-2 (2026-07-08) — present (and `true`) ONLY when the credit note
   * requested an F8 membership-cancellation cascade (full membership
   * credit + `membershipEffect: 'cancel_membership'`) AND that cascade
   * failed to run to completion. The credit note itself is ALWAYS fully
   * committed regardless (§86/10 numbering never depends on F8) — this is
   * a non-blocking warning so the admin knows to retry the cancellation
   * manually from the renewals UI (idempotent). Absent on success / when
   * no cascade was requested.
   */
  readonly membership_cancellation_failed?: true;
}

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
  // LOW-12 — a corrupted event invoice (subject='event' but no
  // event_registration_id) is a data-integrity error, not a transient
  // conflict. 422: well-formed request, but the persisted row cannot be acted on.
  invalid_event_invoice: 422,
  // §86/10 ruling (final-review HIGH 1) — crediting a §105 ใบเสร็จรับเงิน
  // (receipt_separate) is a legally-invalid request, not a transient conflict.
  // 422 Unprocessable Entity: the request is well-formed but cannot be acted on.
  receipt_not_creditable: 422,
  // 088 US6 (§ A.4) — the parent's §86/4 tax receipt PDF has not yet rendered
  // (async 'pending'/'failed'). 409 Conflict: transient, retriable once the
  // receipt materialises (distinct from the 422 legal `receipt_not_creditable`).
  receipt_not_rendered: 409,
  overflow: 422,
  pdf_render_failed: 500,
  blob_upload_failed: 500,
  // F-2 (2026-07-08) — a full membership credit omitted the required
  // `membershipEffect` field. 422 Unprocessable Entity: well-formed
  // request, but the use-case cannot proceed without the staff's
  // declared intent.
  membership_effect_required: 422,
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
    return rateLimitedJson(rl);
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
    // F-2 (2026-07-08) — optional; the schema itself enforces the
    // enum shape + the membership_effect_required gate.
    membershipEffect: rawBody.membershipEffect,
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
  // F-2 (2026-07-08) — the credit note is FULLY COMMITTED at this point
  // (§86/10 numbering never depends on F8). When the caller declared
  // `cancel_membership` on a full membership credit, orchestrate the F8
  // cascade HERE — the ROUTE (presentation), never F4 Application
  // (Principle III: F4 never imports F8). A cascade failure does NOT
  // retroactively fail the credit note — it surfaces as a non-blocking
  // `membership_cancellation_failed` warning field; staff retry via the
  // renewals UI (`cancelInFlightCyclesForMember` is idempotent).
  let membershipCancellationFailed = false;
  if (result.value.membershipCancellationRequested) {
    const memberId = result.value.creditNote.originalInvoiceMemberId;
    if (memberId === null) {
      // Unreachable under normal state — `membershipCancellationRequested`
      // is only true for invoiceSubject==='membership', which the DB CHECK
      // `invoices_subject_fields_ck` guarantees carries a non-null
      // member_id. Log loudly rather than silently skip; the credit note
      // itself is unaffected.
      logger.error(
        {
          requestId,
          tenantId: tenantCtx.slug,
          creditNoteId: result.value.creditNote.creditNoteId,
        },
        'POST /api/credit-notes: membershipCancellationRequested true but originalInvoiceMemberId is null (unreachable — investigate)',
      );
      membershipCancellationFailed = true;
    } else {
      try {
        const cascade = await cancelInFlightCyclesForMember(
          makeRenewalsDeps(tenantCtx.slug),
          {
            tenant: tenantCtx,
            memberId: asMemberId(memberId),
            // F-2 — distinct from the F3 archival cascade's default reason:
            // the member is NOT archived here, they were refunded.
            cascadeReason: 'credit_note_refund',
            initiatedByUserId: ctx.current.user.id,
            requestId,
            correlationId: `credit-note:${result.value.creditNote.creditNoteId}`,
          },
        );
        if (!cascade.ok || cascade.value.outcome !== 'ok') {
          membershipCancellationFailed = true;
          logger.error(
            {
              requestId,
              tenantId: tenantCtx.slug,
              creditNoteId: result.value.creditNote.creditNoteId,
              memberId,
              cascadeOutcome: cascade.ok ? cascade.value.outcome : undefined,
              cascadeErrName: cascade.ok ? undefined : cascade.error.errName,
            },
            'POST /api/credit-notes: F8 membership-cancellation cascade did not complete cleanly',
          );
        }
      } catch (e) {
        membershipCancellationFailed = true;
        logger.error(
          {
            requestId,
            tenantId: tenantCtx.slug,
            creditNoteId: result.value.creditNote.creditNoteId,
            memberId,
            err: e instanceof Error ? e.message : String(e),
          },
          'POST /api/credit-notes: F8 membership-cancellation cascade threw',
        );
      }
    }
  }

  // MEDIUM-5 — surface the email-delivery signal alongside the serialised CN so
  // the client success path can show a non-blocking notice when the buyer has
  // no email on file (`skipped_no_recipient`). The serialiser handles the CN
  // shape; `email_delivery` rides as a sibling field. FIX 8 — the explicit
  // `CreditNoteResponseBody` makes a future serialiser-side `email_delivery`
  // key a compile error rather than a silent override.
  const responseBody: CreditNoteResponseBody = {
    ...serialiseCreditNote(result.value.creditNote),
    email_delivery: result.value.emailDelivery,
    // F-2 — omitted (not `false`) when no cascade was requested or it
    // succeeded; present as `true` only on a genuine cascade failure.
    ...(membershipCancellationFailed ? { membership_cancellation_failed: true } : {}),
  };
  return NextResponse.json(responseBody, { status: 201 });
}
