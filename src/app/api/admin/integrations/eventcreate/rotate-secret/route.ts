/**
 * POST `/api/admin/integrations/eventcreate/rotate-secret`
 *
 * FR-008 — 24h grace-window rotation. Admin-only. Rate-limited
 * 3/hour per (tenant, actor).
 *
 * Default `runtime = 'nodejs'` works today because Drizzle + Neon
 * postgres-js downstream would trigger Node inference, but pinning
 * prevents a future shared-util refactor from accidentally flipping
 * Edge inference on.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  runRotateWebhookSecret,
  rotateSecretRateLimitCheck,
} from '@/lib/events-admin-integration-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { problemResponse } from '@/lib/http/problem-response';
import { adminOnlyGuard } from '../_lib/role-violation-audit';

const ROUTE = '/api/admin/integrations/eventcreate/rotate-secret';
const WARNING =
  'Old secret continues to verify for 24h. Update Zapier within this window.';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: ROUTE,
    attemptedAction: 'rotate_webhook_secret',
  });
  if (guard.kind === 'deny') return guard.response;

  const tenantCtx = resolveTenantFromRequest(request);

  const rl = await rotateSecretRateLimitCheck(
    tenantCtx.slug,
    guard.actorUserId,
  );
  if (!rl.success) {
    const retryAfter = retryAfterSecondsFromRl({ reset: rl.resetAtUnixMs });
    return problemResponse(
      429,
      'rate-limited',
      'Too many requests',
      `Secret-rotation rate limit exceeded. Retry after ${retryAfter}s.`,
      { headers: { 'Retry-After': retryAfter.toString() } },
    );
  }

  // Round 3 H1 — surface a request ID in every 500 problem body so the
  // recovery copy's "contact support with this request ID" promise has
  // an actual identifier to give. The same ID is emitted on the pino
  // error line so SREs can correlate.
  const requestId = crypto.randomUUID();

  try {
    const result = await runRotateWebhookSecret(
      tenantCtx.slug,
      guard.actorUserId,
    );
    if (!result.ok) {
      if (result.error.kind === 'not_found') {
        return new NextResponse(null, { status: 404 });
      }
      logger.error(
        {
          event: 'f6_rotate_secret_failed',
          tenantSlug: tenantCtx.slug,
          errKind: result.error.kind,
          requestId,
        },
        '[F6] rotate-secret use-case failed',
      );
      if (result.error.kind === 'audit_emit_failed') {
        return problemResponse(
          500,
          'audit-emit-failed',
          'Internal Server Error',
          'Webhook secret was rotated, but the audit trail could not be written. The new secret is active and the old secret is in its 24h grace window. Contact support with this request ID for forensic reconstruction.',
          { extras: { requestId } },
        );
      }
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'Rotate-secret failed. Retry; if it persists, contact support.',
        { extras: { requestId } },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        secret: result.value.secret,
        secretLastFour: result.value.secretLastFour,
        graceActiveUntil: result.value.graceActiveUntil,
        warning: WARNING,
      },
      { status: 200 },
    );
  } catch (e) {
    logger.error(
      {
        event: 'f6_rotate_secret_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
        requestId,
      },
      '[F6] rotate-secret route threw',
    );
    return problemResponse(
      500,
      'internal',
      'Internal Server Error',
      'Unexpected error. Retry; if it persists, contact support.',
      { extras: { requestId } },
    );
  }
}
