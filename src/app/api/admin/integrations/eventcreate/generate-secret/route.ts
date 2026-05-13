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
import { problemResponse } from '@/lib/http/problem-response';
import { adminOnlyGuard } from '../_lib/role-violation-audit';

export const runtime = 'nodejs';

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
  // Round 3 H1 — surface a request ID in every 500 problem body.
  const requestId = crypto.randomUUID();

  try {
    const result = await runGenerateWebhookSecret(
      tenantCtx.slug,
      guard.actorUserId,
    );

    if (!result.ok) {
      if (result.error.kind === 'secret_already_exists') {
        return problemResponse(
          409,
          'secret-already-exists',
          'Webhook secret already configured',
          'Use the rotate-secret endpoint to replace the existing secret.',
        );
      }
      logger.error(
        {
          event: 'f6_generate_secret_failed',
          tenantSlug: tenantCtx.slug,
          errKind: result.error.kind,
          requestId,
        },
        '[F6] generate-secret use-case failed',
      );
      if (result.error.kind === 'audit_emit_failed') {
        return problemResponse(
          500,
          'audit-emit-failed',
          'Internal Server Error',
          'Webhook secret was saved, but the audit trail could not be written. Do NOT click Generate again — rotate the secret instead to acknowledge and replace it.',
          { extras: { requestId } },
        );
      }
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'Generate-secret failed. Retry; if it persists, contact support.',
        { extras: { requestId } },
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
        requestId,
      },
      '[F6] generate-secret route threw',
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
