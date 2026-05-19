/**
 * POST `/api/admin/integrations/eventcreate/test-webhook`
 *
 * FR-023 — admin presses "Test webhook"; we sign a synthetic payload
 * with the active secret, POST it to the tenant's own webhook URL,
 * and report the round-trip outcome.
 *
 * Receiver short-circuits on the `__test_webhook__` sentinel external
 * IDs (round-2 P8 — no event/registration row created). Audit
 * (`webhook_test_invoked`) emitted by the receiver per
 * `contracts/admin-integration-eventcreate-api.md` line 127.
 *
 * Admin-only. Rate-limited 10/hour per (tenant, actor).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  runRunTestWebhook,
  testWebhookRateLimitCheck,
} from '@/lib/events-admin-integration-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { problemResponse } from '@/lib/http/problem-response';
import {
  adminOnlyGuard,
  deriveWebhookBaseUrl,
} from '../_lib/role-violation-audit';

const ROUTE = '/api/admin/integrations/eventcreate/test-webhook';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: ROUTE,
    attemptedAction: 'run_test_webhook',
  });
  if (guard.kind === 'deny') return guard.response;

  const tenantCtx = resolveTenantFromRequest(request);

  const rl = await testWebhookRateLimitCheck(
    tenantCtx.slug,
    guard.actorUserId,
  );
  if (!rl.success) {
    const retryAfter = retryAfterSecondsFromRl({ reset: rl.resetAtUnixMs });
    return problemResponse(
      429,
      'rate-limited',
      'Too many requests',
      `Test-webhook rate limit exceeded. Retry after ${retryAfter}s.`,
      { headers: { 'Retry-After': retryAfter.toString() } },
    );
  }

  // Round 3 H1 — surface a request ID in every 500 problem body.
  const requestId = crypto.randomUUID();

  try {
    const result = await runRunTestWebhook(
      tenantCtx.slug,
      guard.actorUserId,
      { webhookBaseUrl: deriveWebhookBaseUrl(request) },
    );
    if (!result.ok) {
      if (result.error.kind === 'config_missing') {
        return new NextResponse(null, { status: 404 });
      }
      // Round 3 M-err-7 — distinguish "row missing" (404) from
      // "DB load failed" (500). The use-case now emits a separate
      // `config_load_failed` discriminant so a transient Neon outage
      // no longer surfaces as misleading 404 to the admin.
      if (result.error.kind === 'config_load_failed') {
        logger.error(
          {
            event: 'f6_test_webhook_config_load_failed',
            tenantSlug: tenantCtx.slug,
            errKind: result.error.errKind,
            requestId,
          },
          '[F6] test-webhook config load failed — propagating as 500',
        );
        return problemResponse(
          500,
          'internal',
          'Internal Server Error',
          'Could not load the webhook configuration. Retry; if it persists, contact support with this request ID.',
          { extras: { requestId } },
        );
      }
      logger.error(
        {
          event: 'f6_test_webhook_failed',
          tenantSlug: tenantCtx.slug,
          errKind: result.error.kind,
          requestId,
        },
        '[F6] test-webhook use-case failed',
      );
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'Test-webhook failed. Retry; if it persists, contact support.',
        { extras: { requestId } },
      );
    }
    return NextResponse.json(result.value, { status: 200 });
  } catch (e) {
    logger.error(
      {
        event: 'f6_test_webhook_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
        requestId,
      },
      '[F6] test-webhook route threw',
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
