/**
 * POST `/api/admin/integrations/eventcreate/disable`
 *
 * FR-033 — per-tenant kill switch toggle. Body `{ enabled: boolean,
 * reason: string }`. Emits `ingest_disabled_tenant_admin` audit.
 * Admin-only.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runToggleIngest } from '@/lib/events-admin-integration-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { adminOnlyGuard } from '../_lib/role-violation-audit';

// Round-6 verify-fix 2026-05-13 (code #8) — explicit Node runtime pin.
export const runtime = 'nodejs';

const ROUTE = '/api/admin/integrations/eventcreate/disable';

const BodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).max(500),
});

export async function POST(request: NextRequest): Promise<Response> {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: ROUTE,
    attemptedAction: 'disable_ingest',
  });
  if (guard.kind === 'deny') return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        type: 'https://chamber-os.app/errors/malformed-body',
        title: 'Invalid request body',
        status: 400,
        errors: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);

  try {
    const result = await runToggleIngest(
      tenantCtx.slug,
      guard.actorUserId,
      parsed.data,
    );
    if (!result.ok) {
      if (result.error.kind === 'not_found') {
        return new NextResponse(null, { status: 404 });
      }
      logger.error(
        {
          event: 'f6_disable_ingest_failed',
          tenantSlug: tenantCtx.slug,
          errKind: result.error.kind,
        },
        '[F6] disable-ingest use-case failed',
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
        event: 'f6_disable_ingest_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] disable route threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }
}
