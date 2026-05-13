/**
 * POST `/api/admin/integrations/eventcreate/generate-secret`
 *
 * FR-024 one-time-reveal flow. Admin-only (manager/member → 404 + audit).
 * 409 Conflict when secret already exists (caller must rotate instead).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runGenerateWebhookSecret } from '@/lib/events-admin-integration-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { adminOnlyGuard } from '../_lib/role-violation-audit';

const ROUTE = '/api/admin/integrations/eventcreate/generate-secret';
const WARNING =
  'Store this value in a password manager. It will not be shown again.';

export async function POST(request: NextRequest): Promise<Response> {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: ROUTE,
    attemptedAction: 'generate_webhook_secret',
  });
  if (guard.kind === 'deny') return guard.response;

  const tenantCtx = resolveTenantFromRequest(request);

  try {
    const result = await runGenerateWebhookSecret(
      tenantCtx.slug,
      guard.actorUserId,
    );

    if (!result.ok) {
      if (result.error.kind === 'secret_already_exists') {
        return NextResponse.json(
          {
            type: 'https://chamber-os.app/errors/secret-already-exists',
            title: 'Webhook secret already configured',
            status: 409,
            detail: 'Use the rotate-secret endpoint to replace the existing secret.',
          },
          { status: 409 },
        );
      }
      logger.error(
        {
          event: 'f6_generate_secret_failed',
          tenantSlug: tenantCtx.slug,
          errKind: result.error.kind,
        },
        '[F6] generate-secret use-case failed',
      );
      return NextResponse.json(
        { title: 'Internal Server Error' },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        secret: result.value.secret,
        secretLastFour: result.value.secretLastFour,
        warning: WARNING,
      },
      { status: 200 },
    );
  } catch (e) {
    logger.error(
      {
        event: 'f6_generate_secret_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] generate-secret route threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }
}
