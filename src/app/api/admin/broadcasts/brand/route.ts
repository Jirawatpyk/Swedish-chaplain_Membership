/**
 * F119 T026 / T026a — `GET | PATCH /api/admin/broadcasts/brand` (FR-041b/c;
 * contracts/admin-eblast-formatting-api.md § brand).
 *
 * `requireApiPermission(request, 'settings.broadcasts')` on BOTH verbs (so
 * `check:api-route-guard` sees it) — admin + super_admin; `marketing` and
 * `manager` are refused 403 `permission_denied` by the gate, audited there.
 *
 * GET 200 `{ primaryColor, postalAddress, addressMissing, logo: { url,
 * source, manageHref }, defaults, updatedAt }` — `manageHref` is non-null
 * ONLY for a `settings.invoicing` holder (super-admin), decided by the
 * evaluator on the SESSION role.
 *
 * PATCH — order of checks is the contract: gate → body shape (400
 * `invalid_body`; **no logo key is accepted**, the schema is strict — FR-041b)
 * → the 30 / 60 s per-(tenant, actor) staff write bucket, consumed BEFORE the
 * write (429 `broadcast_rate_limit_exceeded` + `Retry-After`) → the use case
 * (422 `colour_contrast { ratio, required }`, 422 `validation_error`, 500
 * `internal_error`) → 200 with the refreshed view. A brand change voids
 * nothing (FR-012) — the use case has no port that could.
 *
 * Node runtime (Drizzle + Upstash).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { assertNever } from '@/lib/assert-never';
import { makeBrandSettingsDeps } from '@/lib/broadcast-brand-deps';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import {
  STAFF_WRITE_RATE_MAX,
  STAFF_WRITE_RATE_WINDOW_SECONDS,
  staffWriteRateKey,
} from '@/lib/broadcasts-write-rate-limit';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { canPerform, requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { broadcastsRateLimiter, getBrandSettings, setBrandSettings } from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `.strict()` — a body naming the logo (or anything else) is refused 400:
// FR-041b, the Brand page has no write path to the invoice logo. The zod
// `max` on the address is loose on purpose: the Domain normalises CRLF → LF
// and bounds to 300 so the 422 names the real rule.
const PatchSchema = z
  .object({
    primaryColor: z.string().max(16).nullable().optional(),
    postalAddress: z.string().max(1_000).nullable().optional(),
  })
  .strict()
  .refine((b) => b.primaryColor !== undefined || b.postalAddress !== undefined, {
    message: 'at least one key',
  });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'settings.broadcasts');
  if ('response' in ctx) return ctx.response;
  const tenantCtx = resolveTenantFromRequest(request);
  try {
    const view = await getBrandSettings(makeBrandSettingsDeps(), {
      tenantId: tenantCtx.slug as never,
      // rbac-subgate-ok: gates the `logo.manageHref` FIELD of an already-
      // authorised response (the page that owns the logo is super-admin only,
      // FR-041b); admission is `settings.broadcasts` above.
      canManageInvoiceSettings: canPerform(ctx.current.user.role, 'settings.invoicing'),
    });
    return NextResponse.json(view, { status: 200, headers: baseHeaders(correlationId) });
  } catch (e) {
    logger.error({ err: errKind(e), correlationId, errorId: 'M119.admin.brand.get' }, 'broadcasts.brand.get_failed');
    return errorResponse(500, 'internal_error', correlationId);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'settings.broadcasts');
  if ('response' in ctx) return ctx.response;
  const tenantCtx = resolveTenantFromRequest(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const limit = await broadcastsRateLimiter.checkLimit(
    staffWriteRateKey(tenantCtx.slug, ctx.current.user.id),
    STAFF_WRITE_RATE_MAX,
    STAFF_WRITE_RATE_WINDOW_SECONDS,
  );
  if (!limit.ok) {
    return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
      retryAfterSeconds: limit.error.retryAfterSeconds,
      details: { retryAfterSeconds: limit.error.retryAfterSeconds },
    });
  }

  const deps = makeBrandSettingsDeps();
  const result = await setBrandSettings(deps, {
    tenantId: tenantCtx.slug as never,
    actorUserId: ctx.current.user.id,
    actorRole: ctx.current.user.role ?? null,
    requestId: correlationId,
    primaryColor: parsed.data.primaryColor,
    postalAddress: parsed.data.postalAddress,
  });
  if (!result.ok) {
    switch (result.error.kind) {
      case 'colour_contrast':
        return errorResponse(422, 'colour_contrast', correlationId, {
          details: { ratio: result.error.ratio, required: result.error.required },
        });
      case 'invalid_color_format':
        return errorResponse(422, 'validation_error', correlationId, {
          fieldErrors: { primaryColor: ['invalid_color_format'] },
        });
      case 'address_too_long':
        return errorResponse(422, 'validation_error', correlationId, {
          fieldErrors: { postalAddress: ['address_too_long'] },
          details: { max: result.error.max },
        });
      case 'storage_error':
        logger.error(
          { err: result.error.detail, correlationId, errorId: 'M119.admin.brand.patch.storage' },
          'broadcasts.brand.patch_failed',
        );
        return errorResponse(500, 'internal_error', correlationId);
      default:
        return assertNever(result.error);
    }
  }

  try {
    const view = await getBrandSettings(deps, {
      tenantId: tenantCtx.slug as never,
      // rbac-subgate-ok: same FIELD gate as GET — admission was decided above.
      canManageInvoiceSettings: canPerform(ctx.current.user.role, 'settings.invoicing'),
    });
    return NextResponse.json(view, { status: 200, headers: baseHeaders(correlationId) });
  } catch (e) {
    logger.error({ err: errKind(e), correlationId, errorId: 'M119.admin.brand.patch.reload' }, 'broadcasts.brand.reload_failed');
    return errorResponse(500, 'internal_error', correlationId);
  }
}
