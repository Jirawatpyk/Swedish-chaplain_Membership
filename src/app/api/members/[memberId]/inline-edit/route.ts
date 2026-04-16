/**
 * PATCH /api/members/[memberId]/inline-edit (T112, US4 FR-040).
 *
 * Single-field optimistic update from the directory table.
 * Whitelisted fields: status, country, notes.
 *
 * RBAC: admin-only (`members` / `write`).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { inlineEdit, asMemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const { memberId: rawMemberId } = await params;
  if (!UUID_RE.test(rawMemberId)) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Invalid member ID.' } },
      { status: 404 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);

  const result = await inlineEdit(
    asMemberId(rawMemberId),
    rawBody,
    {
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    },
    {
      tenant,
      memberRepo: deps.memberRepo,
      audit: deps.audit,
      clock: deps.clock,
    },
  );

  if (result.ok) {
    return NextResponse.json(
      {
        member_id: result.value.memberId,
        status: result.value.status,
        country: result.value.country,
        notes: result.value.notes,
        updated_at: result.value.updatedAt.toISOString(),
      },
      { status: 200 },
    );
  }

  switch (result.error.type) {
    case 'invalid_body':
      return NextResponse.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Body failed validation.',
            details: { issues: result.error.issues },
          },
        },
        { status: 400 },
      );
    case 'invalid_field_value':
      return NextResponse.json(
        {
          error: {
            code: 'validation_error',
            message: result.error.reason,
            details: { field: result.error.field },
          },
        },
        { status: 400 },
      );
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    case 'state_error':
      return NextResponse.json(
        {
          error: {
            code: 'state_error',
            message: `State transition failed: ${result.error.code}`,
          },
        },
        { status: 409 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'inline-edit: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
