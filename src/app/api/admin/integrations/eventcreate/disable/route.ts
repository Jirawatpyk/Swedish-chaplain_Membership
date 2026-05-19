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
import {
  runToggleIngest,
  asBoundedReason,
} from '@/lib/events-admin-integration-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { problemResponse } from '@/lib/http/problem-response';
import { adminOnlyGuard } from '../_lib/role-violation-audit';

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
    return problemResponse(
      400,
      'malformed-body',
      'Invalid request body',
      'Request body failed validation. See `errors` for field-level issues.',
      { extras: { errors: parsed.error.issues } },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  // Round 3 H1 — surface a request ID in every 500 problem body.
  const requestId = crypto.randomUUID();

  try {
    const result = await runToggleIngest(
      tenantCtx.slug,
      guard.actorUserId,
      {
        enabled: parsed.data.enabled,
        // Round 3 M-type-5 — brand at the boundary so the use-case +
        // audit payload cannot accept a degenerate empty/oversize
        // string. Schema-level zod check above guarantees the input
        // satisfies the invariant; the brand makes the contract
        // type-system-visible.
        reason: asBoundedReason(parsed.data.reason),
      },
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
          requestId,
        },
        '[F6] disable-ingest use-case failed',
      );
      if (result.error.kind === 'audit_emit_failed') {
        return problemResponse(
          500,
          'audit-emit-failed',
          'Internal Server Error',
          'Ingest state was changed, but the audit trail could not be written. The current state in the dashboard is correct; contact support with this request ID for forensic reconstruction.',
          { extras: { requestId } },
        );
      }
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'Toggle-ingest failed. Retry; if it persists, contact support.',
        { extras: { requestId } },
      );
    }
    return NextResponse.json(result.value, { status: 200 });
  } catch (e) {
    logger.error(
      {
        event: 'f6_disable_ingest_threw',
        tenantSlug: tenantCtx.slug,
        err: e instanceof Error ? e.message : String(e),
        requestId,
      },
      '[F6] disable route threw',
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
