/**
 * GET /api/members/[memberId] (T068, US2 deep-link).
 *
 * Admin + manager read. Cross-tenant probes return 404 + emit
 * `member_cross_tenant_probe` per FR-022.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { getMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { serialiseMember, serialiseContact } from '../_serialise';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const includeDob = url.searchParams.get('include') === 'date_of_birth';

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);
  const result = await getMember(
    parsed.data.memberId as MemberId,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    deps,
  );

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    }
    logger.error(
      { requestId: ctx.requestId, err: result.error },
      'get-member: unhandled',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ...serialiseMember(result.value.member),
      contacts: result.value.contacts.map((c) =>
        serialiseContact(c, {
          includeDateOfBirth: includeDob && ctx.current.user.role === 'admin',
        }),
      ),
    },
    { status: 200 },
  );
}
