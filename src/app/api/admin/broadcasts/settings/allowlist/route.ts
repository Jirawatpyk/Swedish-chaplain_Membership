/**
 * T076 (F7.1a US2) — POST /api/admin/broadcasts/settings/allowlist
 *
 * Admin role + tenant ctx. Add or remove a hostname in the tenant's
 * image-source allowlist (FR-010 / FR-015). Default-seeded rows
 * (is_default=TRUE) are non-removable per FR-010 platform invariant —
 * the use-case returns `cannot_remove_default` → HTTP 403.
 *
 * Wraps `manageImageAllowlist` Application use-case. Tenant resolved
 * via `resolveTenantFromRequest`; auth + RBAC via `requireAdminContext`.
 * Storage path runs inside `runInTenant()` so RLS+FORCE (migration 0166)
 * is the storage-layer guard.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import { makeManageImageAllowlistDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import {
  isF71aUs2Enabled,
  f71aUs2DisabledReason,
} from '@/modules/broadcasts/infrastructure/feature-flags';
import { runInTenant } from '@/lib/db';
import {
  baseHeaders,
  errorResponse,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

// Hostname regex mirrors the Domain VO + DB CHECK constraint
// (migration 0164 + image-source-allowlist.ts:50 + schema.ts:719) —
// kept in sync intentionally; a future amendment must update all four.
const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'invalid_hostname',
  );

const BodySchema = z.object({
  action: z.enum(['add', 'remove']),
  hostname: HostnameSchema,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs2Enabled()) {
    return NextResponse.json(
      { error: 'feature_disabled', reason: f71aUs2DisabledReason() },
      { status: 503, headers: baseHeaders(correlationId) },
    );
  }

  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'update',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    });
  }

  try {
    const result = await runInTenant(tenantCtx, async () => {
      return manageImageAllowlist(makeManageImageAllowlistDeps(tenantCtx.slug), {
        tenantId: tenantCtx.slug as never,
        actorUserId: ctx.current.user.id,
        action: parsed.data.action,
        hostname: parsed.data.hostname,
        requestId: correlationId,
      });
    });

    if (!result.ok) {
      const status =
        result.error.kind === 'cannot_remove_default'
          ? 403
          : result.error.kind === 'invalid_hostname'
            ? 400
            : result.error.kind === 'duplicate'
              ? 409
              : result.error.kind === 'not_found'
                ? 404
                : 500;
      return NextResponse.json(
        { error: result.error.kind },
        { status, headers: baseHeaders(correlationId) },
      );
    }

    return NextResponse.json(
      {
        allowlist: result.value.allowlist.map((e) => ({
          hostname: e.hostname as string,
          isDefault: e.isDefault,
        })),
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.broadcasts.settings.allowlist.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
