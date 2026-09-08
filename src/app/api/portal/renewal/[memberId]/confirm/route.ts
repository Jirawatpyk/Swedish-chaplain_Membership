/**
 * F8 Phase 5 Wave C · T130 — POST `/api/portal/renewal/[memberId]/confirm`.
 *
 * Member confirms their renewal via the public portal page. Wraps the
 * `confirmRenewal` use-case (T122) which optionally updates the cycle's
 * frozen-plan fields (FR-021b atomic), composes F4 createInvoiceDraft +
 * issueInvoice via the F4 invoicing bridge, links the issued invoice to
 * the cycle, and emits the audit chain.
 *
 * Auth: member role only via `requireMemberContext`. The session-member
 * MUST match URL [memberId] — cross-member attempts emit
 * `renewal_cross_member_probe` audit (handled inside the use-case) and
 * return 404 (no oracle per FR-027 generic-error policy).
 *
 * Rate-limit (W0-17, FR-027): 10/1h per member. This endpoint composes F4
 * invoice draft + issuance, so an unbounded confirm loop is an invoice-spam /
 * DoS vector on a money path. The check runs right after the session-vs-URL
 * guard and BEFORE any body parse or invoice work.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import { requireMemberContext } from '@/lib/member-context';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { errorResponse, successResponse } from '@/lib/renewals-route-helpers';
import {
  confirmRenewal,
  makeRenewalsDeps,
  selfServiceFailureReason,
  type SelfServiceFailureReason,
} from '@/modules/renewals';
import { assertNever } from '@/lib/assert-never';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). `pnpm check:f8-error-id` enforces that
 * every 500 this file answers with, and every error-level line inside a catch,
 * carries `F8.PORTAL_CONFIRM` with some suffix — so an alert keyed on `F8.PORTAL_CONFIRM.*` matches those.
 *
 * That is the whole claim, and it is the gate's, not this comment's. Five rounds
 * of review falsified five stronger versions of this docblock — an enumerated
 * suffix list, then "every line this route logs about a failure", which is still
 * untrue wherever a failure is logged at WARN. A comment that describes a
 * checkable rule cannot drift from the file; one that describes the file does.
 */
const ERROR_ID = 'F8.PORTAL_CONFIRM';

const BodySchema = z.object({
  cycleId: z.string().uuid(),
  /** Optional — when present + differs from cycle.planIdAtCycleStart triggers FR-025 plan-change branch. */
  newPlanId: z.string().min(1).optional(),
  // WP4 — the member's downgrade acknowledgement. An ack is only meaningful
  // as affirmative, so the wire type stays `z.literal(true)` (absent ≡ not
  // acknowledged). The `preprocess` coerces any non-`true` value (including an
  // honest `false`) to `undefined` so a legitimate "I did not ack" body is
  // NEVER a 400 (C-9) — the use-case then treats the absent flag as
  // not-acknowledged and refuses a lower-priced switch with a 409.
  acknowledgeDowngrade: z.preprocess(
    (v) => (v === true ? true : undefined),
    z.literal(true).optional(),
  ),
  // 070 (FR-022 / L2 security) — `planYear` is NO LONGER accepted from the
  // request body. The §86/4 fiscal year is a tax-document field that must
  // be SERVER-derived from the authoritative cycle (`confirmRenewal`
  // derives it via `deriveFiscalYear(cycle.period_from)`). A client-posted
  // `planYear` is silently ignored — the non-strict schema drops unknown
  // keys, so an attacker cannot influence the year printed/numbered on the
  // tax invoice.
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
) {
  const correlationId = randomUUID();
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId,
    });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    // Round-5 review: this pass-through was the one path in the 26 F8 routes
    // that answered 500 with nothing an alert rule could match.
    // `requireMemberContext` has three 500 exits; two log at error level with
    // no errorId, and the contacts-lookup one logs NOTHING — the repo swallows
    // the DB error into a Result. A Neon fault while a member submits their
    // renewal therefore died silently on the money path.
    //
    // Logged HERE rather than in the shared helper: that helper serves other
    // portal surfaces, each with its own taxonomy entry. The 24 admin routes
    // get the equivalent line from `requireRenewalAdminContext`.
    //
    // Only the 500. A 401/403/404 from the gate is an ordinary authorisation
    // outcome, and logging those at error level would bury this signal.
    if (ctx.response.status === 500) {
      logger.error(
        {
          errorId: `${ERROR_ID}.CONTEXT_RESOLUTION_FAILED`,
          correlationId,
        },
        'portal.renewal.confirm_context_resolution_failed',
      );
    }
    return ctx.response;
  }

  const { memberId: urlMemberId } = await context.params;

  // C1 review-fix (2026-05-07): session-vs-URL guard. Without this,
  // member A could POST to `/api/portal/renewal/<memberB_id>/confirm`
  // with member B's cycleId and trigger F4 invoice issuance against
  // member B's renewal cycle. The use-case below checks cycle-vs-URL
  // (cross-member-probe), but URL is attacker-controlled — only the
  // session-bound `ctx.memberId` is trusted. Generic 404 per FR-027
  // (no oracle).
  if (urlMemberId !== ctx.memberId) {
    return errorResponse({
      status: 404,
      code: 'cycle_not_found',
      correlationId,
    });
  }

  // Rate-limit (W0-17): bound the money path BEFORE any body parse / invoice work.
  // 10/1h per member — generous for a legitimate confirm-then-retry, but stops an
  // unbounded loop from spamming F4 invoice issuance.
  const rl = await rateLimiter.check(`renewal-confirm:${ctx.tenant.slug}:${ctx.memberId}`, 10, 3600);
  if (!rl.success) {
    return errorResponse({
      status: 429,
      code: 'rate_limited',
      correlationId,
      headers: { 'Retry-After': retryAfterSecondsFromRl({ reset: rl.reset }).toString() },
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId,
    });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const deps = makeRenewalsDeps(ctx.tenant.slug);

  try {
    // Phase 9 / T232 — `member_self_service_renewal` OTel root span
    // wrapping the confirm-renewal use-case. The TTFB < 600ms +
    // confirm p95 < 1.2s budgets per spec.md FR-046 / SC are bound
    // to this span's histogram.
    const result = await withActiveSpan(
      renewalsTracer(),
      'member_self_service_renewal',
      {
        'portal.renewal.tenant_id': ctx.tenant.slug,
        'portal.renewal.has_plan_change':
          parsed.data.newPlanId !== undefined,
      },
      () =>
        confirmRenewal(deps, {
          tenantId: ctx.tenant.slug,
          cycleId: parsed.data.cycleId,
          memberId: urlMemberId,
          ...(parsed.data.newPlanId !== undefined
            ? { newPlanId: parsed.data.newPlanId }
            : {}),
          // WP4 — forward the ack only when affirmatively true (omitted
          // otherwise for exactOptionalPropertyTypes).
          ...(parsed.data.acknowledgeDowngrade === true
            ? { acknowledgeDowngrade: true }
            : {}),
          // 070 — `planYear` intentionally NOT forwarded: the use-case
          // derives the §86/4 fiscal year server-side from the cycle.
          actorUserId: ctx.current.user.id,
          actorRole: 'member',
          requestId: ctx.requestId,
          correlationId,
        }),
    );

    // Phase 9 / T231 — emit per-tenant failure counter for FR-046
    // conversion-funnel dashboard. The success counter is emitted
    // inside confirm-renewal use-case (post-tx); the failure counter
    // lives at the route boundary because the use-case does not
    // have a "global try/catch -> failure metric" path.
    if (!result.ok) {
      renewalsMetrics.selfServiceFailed(
        ctx.tenant.slug,
        selfServiceFailureReason(result.error),
      );
    }

    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId,
            details: { message: result.error.message },
          });
        case 'cycle_not_found':
        case 'cross_member_probe':
          // FR-027 generic-error — no oracle leaking which case fired.
          return errorResponse({
            status: 404,
            code: 'cycle_not_found',
            correlationId,
          });
        case 'cycle_not_payable':
          return errorResponse({
            status: 409,
            code: 'cycle_not_payable',
            correlationId,
            details: { current_status: result.error.currentStatus },
          });
        case 'plan_not_found':
        case 'plan_inactive':
          return errorResponse({
            status: 400,
            code: result.error.kind,
            correlationId,
          });
        case 'invoice_already_exists':
          // 107-auto-invoice Task 9 (review Important 2) — a bill for this
          // renewal already exists (typically issued by a treasurer from the
          // auto-renewal review queue). 409, not an error state: the member
          // should PAY that bill. `invoice_id` lets the portal redirect
          // straight to it rather than dead-ending the member.
          return errorResponse({
            status: 409,
            code: 'invoice_already_exists',
            correlationId,
            details: { invoice_id: result.error.invoiceId },
          });
        case 'downgrade_not_acknowledged':
          // WP4 — 409: the member must confirm the lower-priced switch. Echo
          // the server-derived prices + currency so the client renders the
          // before/after in the downgrade dialog (the client never posts a
          // price — these are authoritative).
          return errorResponse({
            status: 409,
            code: 'downgrade_not_acknowledged',
            correlationId,
            details: {
              current_price_minor_units: result.error.currentPriceMinorUnits,
              new_price_minor_units: result.error.newPriceMinorUnits,
              currency: result.error.currency,
            },
          });
        case 'invoice_creation_failed':
          return errorResponse({
            status: 502,
            code: 'invoice_creation_failed',
            correlationId,
            details: { stage: result.error.stage },
          });
        case 'server_error':
          // Round-2 review — this arm returns the 500 this route produces
          // MOST often (the use-case caught something), and it logged no
          // errorId, so the docblock's promise that a rule keyed on
          // `${ERROR_ID}.*` matches every 500 was false for the common case.
          // `accept/route.ts` had done this since R3-S5; nothing else had.
          logger.error(
            {
              errorId: `${ERROR_ID}.SERVER_ERROR`,
              // This route is member-facing: its correlationId is a local
              // `randomUUID()`, not `ctx.correlationId` — `ctx` here is a
              // `MemberContext` and has no such field. The scripted pass
              // assumed the admin shape; `tsc` caught it.
              correlationId,
            },
            'portal.renewal.confirm_server_error',
          );
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId,
          });
        default: {
          // Review of this branch — this arm RETURNED the 500, so the one
          // failure mode that means "two deploys disagree" produced a 500
          // with no log line at all. Throwing lands it in the outer catch,
          // which does carry the id.
          //
          // (This carried a parenthetical claiming the file's docblock made no
          // such promise. The very next commit added one and deleted the
          // sentence it cited — a comment about a neighbouring comment, made
          // false by the commit that claimed to be closing exactly that class.
          // Removed rather than re-worded: it described no behaviour.)
          return assertNever(
            result.error,
            `${ERROR_ID}: unhandled error kind '${
              (result.error as { readonly kind: string }).kind
            }'`,
          );
        }
      }
    }

    return successResponse(
      {
        invoice_id: result.value.invoiceId,
        invoice_number: result.value.invoiceNumber,
        pay_url: result.value.payUrl,
        plan_changed: result.value.planChanged,
      },
      correlationId,
    );
  } catch (e) {
    // Phase 9 verify-fix C1 — emit selfServiceFailed counter on the
    // outer-catch path BEFORE the 500 response. Without this, an
    // unexpected throw (runInTenant connection drop, F4-bridge
    // TypeError, OTel adapter throw) would log + 500 but the
    // FR-046 conversion-funnel dashboard would record ZERO failures
    // → green-flagged broken portal.
    //
    // Round-2 close: pin the label as `'unexpected_error'` via the
    // shared `SelfServiceFailureReason` literal union (closes the
    // cardinality-drift loophole where the route was emitting a
    // label string outside the mapper's range).
    const unhandledReason: SelfServiceFailureReason = 'unexpected_error';
    renewalsMetrics.selfServiceFailed(ctx.tenant.slug, unhandledReason);
    logger.error(
      {
        errorId: `${ERROR_ID}.UNEXPECTED`,
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        urlMemberId,
        tenantId: ctx.tenant.slug,
      },
      'confirm-renewal route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId,
    });
  }
}
