/**
 * F119 T105 — `POST /api/admin/broadcasts/test-copy` (staff; FR-037).
 *
 * `requireApiPermission(request, 'broadcasts.write')` — a `manager` is
 * read-only and cannot send a test copy (contract § permission map). Then
 * the shared handler: the recipient is the STAFF session address (a staff
 * user cannot send a test to the member), 10 / hour per staff user, the
 * identical pipeline. `related_member_id` is null here in PR-1 (the
 * compose-on-behalf and template screens); the PR-2 format surface passes
 * the E-Blast's owner through `broadcastId`. Node runtime.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { handleTestCopy } from '@/lib/broadcasts-test-copy-route';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.write');
  if ('response' in ctx) return ctx.response;
  const tenantCtx = resolveTenantFromRequest(request);
  return handleTestCopy(
    request,
    {
      tenantSlug: tenantCtx.slug,
      userId: ctx.current.user.id,
      email: ctx.current.user.email,
      role: ctx.current.user.role ?? null,
      relatedMemberId: null,
      surface: 'staff',
    },
    correlationId,
  );
}
