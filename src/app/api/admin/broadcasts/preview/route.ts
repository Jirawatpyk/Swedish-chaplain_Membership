/**
 * F119 T032 — `POST /api/admin/broadcasts/preview` (staff format surface;
 * research R11, FR-043).
 *
 * `requireApiPermission(request, 'broadcasts.read')` — a `manager` may
 * preview (read-only), so the read key is the right one — then the shared
 * preview handler (`src/lib/broadcasts-preview-route.ts`): 400
 * `invalid_body`, 429 at 30 renders / minute per actor, 200 `{ html }` from
 * the SAME wrapper the sender uses. No audit event. Node runtime.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { handlePreview } from '@/lib/broadcasts-preview-route';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.read');
  if ('response' in ctx) return ctx.response;
  const tenantCtx = resolveTenantFromRequest(request);
  return handlePreview(
    request,
    { tenantSlug: tenantCtx.slug, userId: ctx.current.user.id, surface: 'staff' },
    correlationId,
  );
}
