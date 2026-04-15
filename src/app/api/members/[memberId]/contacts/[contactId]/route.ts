/**
 * PATCH + DELETE /api/members/[memberId]/contacts/[contactId] (T091, US3).
 *
 * PATCH: edit non-email contact fields (email change is US3.b).
 * DELETE: soft-remove. Refuses to remove a primary (client must promote
 *         another contact first).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  rememberIdempotentResponse,
  hashRequestBody,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { updateContactFields, removeContact } from '@/modules/members';
import type { ContactId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { serialiseContact } from '../../../_serialise';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
  contactId: z.string().uuid(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string; contactId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'contacts',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Contact not found.' } },
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

  const keyCheck = parseIdempotencyKey(request.headers);
  if (!keyCheck.ok) {
    return NextResponse.json(
      { error: { code: 'missing_idempotency_key', message: 'Idempotency-Key required.' } },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const bodyHash = hashRequestBody(rawBody, `PATCH /contacts/${parsed.data.contactId}`);
  const classification = await classifyIdempotencyRequest(
    tenant,
    keyCheck.key,
    bodyHash,
  );
  if (classification.kind === 'replay') {
    return NextResponse.json(classification.previousResponse.body, {
      status: classification.previousResponse.status,
    });
  }
  if (classification.kind === 'conflict') {
    return NextResponse.json(
      { error: { code: 'idempotency_conflict', message: 'Idempotency-Key reused with different body.' } },
      { status: 409 },
    );
  }
  await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);

  const deps = buildMembersDeps(tenant);
  const result = await updateContactFields(
    parsed.data.contactId as ContactId,
    rawBody,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    deps,
  );

  if (result.ok) {
    const body = serialiseContact(result.value);
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
      status: 200,
      body,
    });
    return NextResponse.json(body, { status: 200 });
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
    case 'invalid_phone':
      return NextResponse.json(
        {
          error: {
            code: 'validation_error',
            message: 'Domain validation failed.',
            details: result.error,
          },
        },
        { status: 400 },
      );
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Contact not found.' } },
        { status: 404 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'update-contact: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string; contactId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'contacts',
    action: 'delete',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Contact not found.' } },
      { status: 404 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);
  const result = await removeContact(
    parsed.data.contactId as ContactId,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    deps,
  );

  if (result.ok) {
    return NextResponse.json(serialiseContact(result.value), { status: 200 });
  }

  switch (result.error.type) {
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Contact not found.' } },
        { status: 404 },
      );
    case 'cannot_remove_primary':
      return NextResponse.json(
        {
          error: {
            code: 'cannot_remove_primary',
            message: 'Cannot remove the primary contact. Promote another contact first.',
          },
        },
        { status: 409 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'remove-contact: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
