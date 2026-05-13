/**
 * GET `/api/admin/integrations/eventcreate`
 *
 * Phase 5 / US3 admin integration config view per
 * `contracts/admin-integration-eventcreate-api.md § GET`.
 *
 * Authz: admin only. Manager + member → 404 (FR-035 surface-disclosure)
 * with `role_violation_blocked` audit. No-session → 404 (no actor to
 * attribute). Kill-switch off → 404.
 *
 * Tenant scope: every query path goes through `runInTenant(ctx, fn)`
 * via the composition adapter — Constitution Principle I.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runLoadIntegrationConfig } from '@/lib/events-admin-integration-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { adminOnlyGuard, deriveWebhookBaseUrl } from './_lib/role-violation-audit';

const ROUTE = '/api/admin/integrations/eventcreate';

export async function GET(request: NextRequest): Promise<Response> {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: ROUTE,
    attemptedAction: 'load_integration_config',
  });
  if (guard.kind === 'deny') return guard.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const includeTestDeliveries =
    new URL(request.url).searchParams.get('includeTestDeliveries') === 'true';

  try {
    const view = await runLoadIntegrationConfig(tenantCtx.slug, {
      includeTestDeliveries,
      webhookBaseUrl: deriveWebhookBaseUrl(request),
    });
    return NextResponse.json(view, { status: 200 });
  } catch (e) {
    logger.error(
      {
        event: 'f6_load_integration_config_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] /api/admin/integrations/eventcreate GET — runLoadIntegrationConfig threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }
}
