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
import {
  adminOnlyGuard,
  deriveWebhookBaseUrl,
} from '../_lib/role-violation-audit';

const ROUTE = '/api/admin/integrations/eventcreate/test-webhook';

function retryAfterSeconds(reset: number): number {
  const seconds = Math.ceil((reset - Date.now()) / 1000);
  return seconds > 0 ? seconds : 60;
}

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
    const retryAfter = retryAfterSeconds(rl.reset);
    return NextResponse.json(
      {
        type: 'https://chamber-os.app/errors/rate-limited',
        title: 'Too many requests',
        status: 429,
        detail: `Test-webhook rate limit exceeded. Retry after ${retryAfter}s.`,
      },
      {
        status: 429,
        headers: { 'Retry-After': retryAfter.toString() },
      },
    );
  }

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
      logger.error(
        {
          event: 'f6_test_webhook_failed',
          tenantSlug: tenantCtx.slug,
          errKind: result.error.kind,
        },
        '[F6] test-webhook use-case failed',
      );
      return NextResponse.json(
        { title: 'Internal Server Error' },
        { status: 500 },
      );
    }
    return NextResponse.json(result.value, { status: 200 });
  } catch (e) {
    logger.error(
      {
        event: 'f6_test_webhook_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] test-webhook route threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }
}
