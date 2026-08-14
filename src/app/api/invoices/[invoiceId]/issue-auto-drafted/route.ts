/**
 * 107-auto-invoice Task 14 — POST /api/invoices/[invoiceId]/issue-auto-drafted.
 *
 * The admin review-queue's "Issue + Send" / "Issue silently" row action.
 * The ONLY human-reachable path to `issueAutoDraftedRenewal` (Task 9) — the
 * generic `/api/invoices/[invoiceId]/issue` route REFUSES an
 * `origin='auto_renewal'` draft outright (Task 10), so every guard Task 9
 * built (duplicate-§86/4 barrier, plan-year-drift refusal, terminated-member
 * gate, sibling-draft sweep) is reached through THIS route or not at all.
 *
 * Admin-only (money-mutation write on the `invoice` resource — manager is
 * read-only on finance per Constitution, enforced by `requireAdminContext`'s
 * `{resource:'invoice', action:'write'}` policy check, same as the sibling
 * `/issue` and `/void` routes).
 *
 * Rate limit: 60/5min per (tenant, actor) — review round 1 MINOR — HIGHER
 * than the sibling `/issue` route's 20/5min. That bucket was sized for the
 * manual single-invoice flow ("legitimate admins rarely issue >20 invoices
 * in 5 minutes" — its own comment). THIS route's entire reason for existing
 * is the opposite shape: a treasurer clearing dozens of cron-drafted rows in
 * one sitting during the annual renewal batch is the PRIMARY flow, not an
 * edge case, so the sibling's cap would routinely fire on legitimate use.
 * 60/5min (~1 confirmed action per 5s) still bounds a scripted/runaway
 * burst — Task 9's guards (duplicate-live-bill content check,
 * status-guarded sibling sweep) are the actual defence against a double
 * mint regardless of rate; this cap is defence-in-depth, not the primary
 * guard. A 429 here maps to `errors.rateLimited`/`rateLimitedWithSeconds`
 * client-side (NOT the generic failure copy) so it reads as "wait", not
 * "broken".
 *
 * `sendEmail` is a REQUIRED body field, not an optional one defaulting to
 * `false` — Task 4's `??`-chain gotcha (a "no opinion" `false` silently
 * meaning "don't send" on a tenant with auto-email ON) must not resurface
 * at the HTTP boundary either. The UI's two distinct menu actions ("Issue +
 * Send" / "Issue silently") each POST an explicit boolean.
 *
 * No Idempotency-Key header — this route family
 * (`/api/invoices/[invoiceId]/**`) has never used one (unlike
 * `/api/members/**` / `/api/plans/**`, which do); the use-case's own
 * duplicate-live-bill content guard + status-guarded sibling-draft sweep
 * already make a doubled click land on `duplicate_live_bill` /
 * `draft_not_found` rather than a second §86/4, so a client-supplied
 * idempotency token would add a second, redundant safety net on a surface
 * that already fails closed.
 */
import { z } from 'zod';
import { NextResponse, type NextRequest } from 'next/server';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  issueAutoDraftedRenewal,
  makeIssueAutoDraftedRenewalDeps,
  type IssueAutoDraftError,
} from '@/modules/renewals';
import { issueErrorStatus, isIssuanceServerFault } from '../../_serialise';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';

const bodySchema = z.object({
  sendEmail: z.boolean(),
});

/**
 * Status map for every `IssueAutoDraftError` kind EXCEPT `issue_failed`
 * (which forwards its wrapped F4 `errorCode` through the shared
 * `issueErrorStatus` table the generic `/issue` route already uses — the
 * same underlying failure should map to the same HTTP status regardless of
 * which route reached `issueInvoice`).
 *
 * `invalid_draft` → 422 ("valid draft, wrong action for it right now" —
 * same class as the generic route's `origin_auto_renewal_use_queue`).
 * `member_terminated` / `duplicate_live_bill` → 409 (a real state conflict:
 * the member's access state, or a competing bill, blocks this exact
 * action). `draft_not_found` / `cycle_not_found` → 404 (the row the queue
 * showed no longer resolves — a concurrent Issue/Discard/prune raced it).
 */
const STATUS_BY_KIND: Readonly<
  Record<Exclude<IssueAutoDraftError['kind'], 'issue_failed'>, number>
> = {
  invalid_input: 400,
  draft_not_found: 404,
  cycle_not_found: 404,
  invalid_draft: 422,
  member_terminated: 409,
  member_erased: 409,
  duplicate_live_bill: 409,
};

function statusForError(error: IssueAutoDraftError): number {
  if (error.kind === 'issue_failed') return issueErrorStatus(error.errorCode);
  return STATUS_BY_KIND[error.kind];
}

/**
 * Serialise the typed error for the client. Deliberately narrower than a
 * blanket `{...error}` spread:
 *   - `invalid_draft.detail` / `issue_failed.detail` / `member_terminated.
 *     reason` (the terminated-cycle's own free-text reason string) carry
 *     internal diagnostic prose (mirrors `stripReason` on the sibling
 *     `/issue` route) and are withheld from the HTTP response.
 *   - `invalid_draft.reason` (a closed 4-value enum: not_auto_renewal /
 *     not_draft / member_mismatch / plan_year_drift) and
 *     `duplicate_live_bill`'s `conflictingInvoiceId`/`conflictingStatus`
 *     ARE forwarded — the UI needs `reason` to render the SAME
 *     `plan_year_drift` copy Task 13's queue badge already showed for this
 *     row (parity requirement), and `conflictingInvoiceId` already reaches
 *     the client today via `loadAutoRenewalQueueContext`'s
 *     `refusalReason.duplicateLiveBill` prediction — this is not a new
 *     exposure.
 */
function serialiseError(error: IssueAutoDraftError): Record<string, unknown> {
  switch (error.kind) {
    case 'invalid_draft':
      return { code: error.kind, reason: error.reason };
    case 'duplicate_live_bill':
      return {
        code: error.kind,
        conflicting_invoice_id: error.conflictingInvoiceId,
        conflicting_status: error.conflictingStatus,
      };
    case 'issue_failed':
      return { code: error.kind, error_code: error.errorCode };
    case 'invalid_input':
    case 'draft_not_found':
    case 'cycle_not_found':
    case 'member_terminated':
    // `member_erased` carries no payload BY DESIGN — the bare code is all the
    // UI needs, and anything more would leak detail about a subject who
    // exercised Art.17 onto the wire.
    case 'member_erased':
      return { code: error.kind };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireApiPermission(request, 'invoicing.issue');
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // 60 per (tenant, actor) per 5 min — see the module header for why this
  // is 3× the sibling `/issue` bucket (batch-clearing is this route's
  // PRIMARY flow, not an edge case).
  const rl = await rateLimiter.check(
    `f4:issue-auto-drafted:${tenantCtx.slug}:${ctx.current.user.id}`,
    60,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/invoices/[id]/issue-auto-drafted rate-limited',
    );
    return rateLimitedJson(rl);
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'invalid_body' } }, { status: 400 });
  }

  const result = await issueAutoDraftedRenewal(
    makeIssueAutoDraftedRenewalDeps(tenantCtx.slug),
    {
      tenantId: tenantCtx.slug,
      invoiceId,
      actorUserId: ctx.current.user.id,
      // A definite send-vs-silent choice, threaded verbatim — never a
      // fallback default. See the module header + `IssueAutoDraftedRenewalInput.sendEmail`'s own docstring.
      sendEmail: parsed.data.sendEmail,
      requestId,
    },
  );

  if (!result.ok) {
    const failureLog = {
      requestId,
      tenantId: tenantCtx.slug,
      invoiceId,
      errorCode: result.error.kind,
    };
    if (
      result.error.kind === 'issue_failed' &&
      isIssuanceServerFault(result.error.errorCode)
    ) {
      logger.error(failureLog, 'POST /api/invoices/[id]/issue-auto-drafted failed');
    } else {
      logger.warn(failureLog, 'POST /api/invoices/[id]/issue-auto-drafted failed');
    }
    renewalsMetrics.autoDraftIssueFailed(tenantCtx.slug, result.error.kind);
    return NextResponse.json(
      { error: serialiseError(result.error) },
      { status: statusForError(result.error) },
    );
  }

  // Observability (107 follow-up) — a §86/4 was minted, and the tx1 sibling
  // sweep may have superseded 0+ competing drafts. Emit AFTER the ok result
  // so a refusal above never counts as an issue.
  renewalsMetrics.autoDraftIssued(tenantCtx.slug);
  if (result.value.discardedInvoiceIds.length > 0) {
    renewalsMetrics.autoDraftDiscarded(
      tenantCtx.slug,
      'superseded_on_issue',
      result.value.discardedInvoiceIds.length,
    );
  }

  // FR-* Cluster 5 parity — surface the same non-fatal signals the manual
  // issue dialog does (supersede-void warnings, and here also a link-step
  // warning when the cycle could not be flipped/linked even after the
  // idempotent retry — Task 11's reconcile cron is the backstop).
  return NextResponse.json(
    {
      invoice_id: result.value.invoiceId,
      invoice_number: result.value.invoiceNumber,
      supersede_warnings: result.value.supersedeWarnings,
      link_warning: result.value.linkWarning,
      discarded_invoice_ids: result.value.discardedInvoiceIds,
    },
    { status: 200 },
  );
}
