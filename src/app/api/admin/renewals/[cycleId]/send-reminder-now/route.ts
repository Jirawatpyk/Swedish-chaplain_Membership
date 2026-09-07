/**
 * F8 Phase 4 Wave I6+I7 · T107 — POST `/api/admin/renewals/[cycleId]/send-reminder-now`.
 *
 * Admin-only manual reminder trigger per FR-018 + spec.md:197 Edge Case
 * "Concurrent admin actions on same cycle/member". Shares the
 * `dispatchOneCycle` core path with the daily cron (T088), so audit +
 * idempotency + retry semantics are identical between cron and admin
 * surfaces.
 *
 * Outcome → HTTP mapping:
 *   - sent / task_created / failed_transient / failed_permanent
 *     / skipped(non-already_sent) → 200 with `{ outcome }` body so the
 *     UI can render the right toast variant (T108).
 *   - skipped(already_sent) → 409 with `existing_reminder_event_id` +
 *     `existing_dispatched_at` so the UI can render the FR-058 "Already
 *     sent {ago}" toast (Edge Case concurrent-admin contract).
 *   - cycle_not_found → 404; invalid_input → 400.
 *
 * Manager 403 emits `f8_role_violation_blocked` audit via the shared
 * `requireRenewalAdminContext` helper.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { sendReminderNow, makeRenewalsDeps } from '@/modules/renewals';
import { assertNever } from '@/lib/assert-never';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it, so an SRE rule keyed on `F8.CYCLE_SEND_REMINDER.*` matches every failure
 * this route can produce.
 *
 * Which suffixes exist here is whatever the code below emits — deliberately
 * NOT listed. Four rounds of review found an enumerated list false as soon as
 * a suffix moved: naming two was wrong once `.SERVER_ERROR` landed, and naming
 * `.SERVER_ERROR` was wrong for the routes that have no `server_error` arm.
 * `pnpm check:f8-error-id` is what holds the claim above true.
 */
const ERROR_ID = 'F8.CYCLE_SEND_REMINDER';

/**
 * 30 requests per 5 minutes per (tenant, admin). Generous headroom for
 * the legitimate "fire reminders before today's chamber event" workflow
 * while still bounding accidental click-storms.
 */
const RL_LIMIT = 30;
const RL_WINDOW_SECONDS = 300;

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

  const ctx = await requireRenewalAdminContext(
    request,
    'write',
    'renewals.write',
    ERROR_ID,
  );
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);

  const rl = await rateLimiter.check(
    `f8:send-reminder-now:${tenantCtx.slug}:${ctx.current.user.id}`,
    RL_LIMIT,
    RL_WINDOW_SECONDS,
  );
  if (!rl.success) {
    return errorResponse({
      status: 429,
      code: 'rate_limited',
      correlationId: ctx.correlationId,
      headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
    });
  }

  const { cycleId } = await context.params;
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await sendReminderNow(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
      actorUserId: ctx.current.user.id,
      // rbac-narrow-ok: stamps the LITERAL role into the audit row; the
      // gate above already decided admission (016 post-ship finding #3).
      actorRole: ctx.current.user.role === 'super_admin' ? 'super_admin' : 'admin',
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
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
        case 'server_error':
          // K1-C7: server_error variant from sendReminderNow.
          // Round-2 review — this arm returns the 500 this route produces
          // MOST often (the use-case caught something), and it logged no
          // errorId, so the docblock's promise that a rule keyed on
          // `${ERROR_ID}.*` matches every 500 was false for the common case.
          // `accept/route.ts` had done this since R3-S5; nothing else had.
          logger.error(
            {
              errorId: `${ERROR_ID}.SERVER_ERROR`,
              correlationId: ctx.correlationId,
            },
            'admin.renewals.send_reminder_now_server_error',
          );
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          // K1-E1: exhaustiveness pin.
          // Review of this branch — this arm RETURNED the 500, so the one
          // failure mode that means "two deploys disagree" produced a 500
          // with no log line at all, while the docblock above promised an
          // SRE rule keyed on `${ERROR_ID}.*` matches every 500 this route
          // can produce. Throwing lands it in the outer catch, which does
          // carry that id.
          return assertNever(
            result.error,
            `${ERROR_ID}: unhandled error kind '${
              (result.error as { readonly kind: string }).kind
            }'`,
          );
        }
      }
    }

    const outcome = result.value;

    // Idempotency replay → 409 + concurrent-admin toast payload.
    if (outcome.kind === 'skipped' && outcome.reason === 'already_sent') {
      const meta = outcome.metadata ?? {};
      return errorResponse({
        status: 409,
        code: 'already_sent',
        correlationId: ctx.correlationId,
        details: {
          existing_reminder_event_id: meta.existing_reminder_event_id,
          existing_dispatched_at: meta.existing_dispatched_at,
        },
      });
    }

    return successResponse({ outcome }, ctx.correlationId);
  } catch (e) {
    logger.error(
      {
        errorId: `${ERROR_ID}.UNEXPECTED`,
        // K12-3 (REL-K-1): pass the Error instance so pino's `err`
        // serializer captures stack + type.
        err: e instanceof Error ? e : new Error(String(e)),
        cycleId,
        correlationId: ctx.correlationId,
        tenantId: tenantCtx.slug,
      },
      'send-reminder-now route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
