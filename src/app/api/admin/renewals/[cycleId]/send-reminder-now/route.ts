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

  const ctx = await requireRenewalAdminContext(request, 'write');
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
      actorRole: 'admin',
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
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          // K1-E1: exhaustiveness pin.
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
