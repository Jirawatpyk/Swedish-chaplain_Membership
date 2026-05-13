/**
 * POST `/api/admin/integrations/eventcreate/rotate-secret`
 *
 * FR-008 — 24h grace-window rotation. Admin-only. Rate-limited
 * 3/hour per (tenant, actor).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  runRotateWebhookSecret,
  rotateSecretRateLimitCheck,
} from '@/lib/events-admin-integration-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { adminOnlyGuard } from '../_lib/role-violation-audit';

const ROUTE = '/api/admin/integrations/eventcreate/rotate-secret';
const WARNING =
  'Old secret continues to verify for 24h. Update Zapier within this window.';

// Round-6 verify-fix 2026-05-13 (code #8) — explicit Node runtime
// pin. Default works today because Drizzle + Neon postgres-js downstream
// would trigger Node inference, but pinning prevents a future shared-util
// refactor from accidentally flipping Edge inference on.
export const runtime = 'nodejs';

function retryAfterSeconds(resetAtUnixMs: number): number {
  const seconds = Math.ceil((resetAtUnixMs - Date.now()) / 1000);
  return seconds > 0 ? seconds : 60;
}

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
    const retryAfter = retryAfterSeconds(rl.resetAtUnixMs);
    return NextResponse.json(
      {
        type: 'https://chamber-os.app/errors/rate-limited',
        title: 'Too many requests',
        status: 429,
        detail: `Secret-rotation rate limit exceeded. Retry after ${retryAfter}s.`,
      },
      {
        status: 429,
        headers: { 'Retry-After': retryAfter.toString() },
      },
    );
  }

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
        },
        '[F6] rotate-secret use-case failed',
      );
      // Round 2 SF-H1 + SF-H4 (2026-05-13) — distinct `detail` for
      // audit-emit-failed so the admin knows the rotation committed
      // but the trail is broken.
      if (result.error.kind === 'audit_emit_failed') {
        return NextResponse.json(
          {
            type: 'https://chamber-os.app/errors/audit-emit-failed',
            title: 'Internal Server Error',
            status: 500,
            detail:
              'Webhook secret was rotated, but the audit trail could not be written. The new secret is active and the old secret is in its 24h grace window. Contact support with this request ID for forensic reconstruction.',
          },
          { status: 500 },
        );
      }
      return NextResponse.json(
        {
          type: 'https://chamber-os.app/errors/internal',
          title: 'Internal Server Error',
          status: 500,
          detail: 'Rotate-secret failed. Retry; if it persists, contact support.',
        },
        { status: 500 },
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
      },
      '[F6] rotate-secret route threw',
    );
    return NextResponse.json(
      {
        type: 'https://chamber-os.app/errors/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Unexpected error. Retry; if it persists, contact support.',
      },
      { status: 500 },
    );
  }
}
