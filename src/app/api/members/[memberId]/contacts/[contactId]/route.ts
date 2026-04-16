/**
 * PATCH + DELETE /api/members/[memberId]/contacts/[contactId] (T091, US3).
 *
 * PATCH: edit contact fields. An `email` field in the body is a SPECIAL
 *        case — when the contact is linked to an F1 user it routes
 *        through the FR-012a atomic change-contact-email transaction
 *        (session revocation + dual-channel email); when there is no
 *        linked user, the email is written in-place via the simple
 *        contact-update path. Both shapes are accepted in a single
 *        PATCH, but a mixed-payload is split internally so the
 *        non-email fields also persist.
 * DELETE: soft-remove. Refuses to remove a primary (client must
 *         promote another contact first).
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
import {
  changeContactEmail,
  removeContact,
  updateContactFields,
} from '@/modules/members';
import type { ContactId, MemberId } from '@/modules/members';
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

  // Split the body: email is routed through the atomic txn path;
  // everything else goes through the simple contact-update path.
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const emailValue =
    typeof body.email === 'string' ? body.email.trim() : undefined;
  const nonEmailBody: Record<string, unknown> = { ...body };
  delete nonEmailBody.email;
  delete nonEmailBody.locale; // consumed by changeContactEmail, not a contact field
  const hasNonEmail = Object.keys(nonEmailBody).length > 0;

  // 1) Email change first (if present) — atomic with session revocation
  //    when a linked user exists; falls back to in-tx email-only update
  //    when there is no linked user.
  if (emailValue !== undefined) {
    const contactLookup = await deps.contactRepo.findById(
      tenant,
      parsed.data.contactId as ContactId,
    );
    if (!contactLookup.ok) {
      if (contactLookup.error.code === 'repo.not_found') {
        return NextResponse.json(
          { error: { code: 'not_found', message: 'Contact not found.' } },
          { status: 404 },
        );
      }
      logger.error(
        { requestId: ctx.requestId, err: contactLookup.error },
        'patch-contact: contact lookup failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
    }
    const contact = contactLookup.value;

    if (contact.linkedUserId) {
      // FR-012a 6-step atomic transaction
      const localeRaw =
        typeof body.locale === 'string' && /^(en|th|sv)$/.test(body.locale)
          ? (body.locale as 'en' | 'th' | 'sv')
          : 'en';
      const changeResult = await changeContactEmail(
        {
          tenant,
          contactRepo: deps.contactRepo,
          userEmails: deps.userEmails,
          sessions: deps.sessions,
          tokens: deps.tokens,
          emails: deps.emails,
          clock: deps.clock,
        },
        {
          contactId: parsed.data.contactId as ContactId,
          newEmailRaw: emailValue,
          actorUserId: ctx.current.user.id,
          requestId: ctx.requestId,
          locale: localeRaw,
        },
      );
      if (!changeResult.ok) {
        switch (changeResult.error.code) {
          case 'invalid_input':
            return NextResponse.json(
              {
                error: {
                  code: 'validation_error',
                  message: 'Invalid email address.',
                  details: { field: changeResult.error.field },
                },
              },
              { status: 400 },
            );
          case 'not_found':
            return NextResponse.json(
              { error: { code: 'not_found', message: 'Contact not found.' } },
              { status: 404 },
            );
          case 'conflict':
            return NextResponse.json(
              {
                error: {
                  code: 'conflict',
                  message: 'Email already in use.',
                  reason: changeResult.error.reason,
                },
              },
              { status: 409 },
            );
          default:
            logger.error(
              { requestId: ctx.requestId, err: changeResult.error },
              'change-contact-email: unhandled',
            );
            return NextResponse.json(
              { error: { code: 'server_error', message: 'Internal server error.' } },
              { status: 500 },
            );
        }
      }
    } else {
      // No linked user — email change requires the FR-012a atomic
      // transaction (session revocation + dual-channel email) which
      // needs a linked user. Reject with a clear message.
      return NextResponse.json(
        {
          error: {
            code: 'not_supported',
            message:
              'Email change is only supported for contacts linked to a portal user. Ask the primary contact to add the new address as a secondary contact, then promote.',
          },
        },
        { status: 409 },
      );
    }
  }

  // 2) Non-email fields (if present, or if the body was email-only
  //    we still re-fetch so the response shape is identical).
  const result = hasNonEmail
    ? await updateContactFields(
        parsed.data.memberId as MemberId,
        parsed.data.contactId as ContactId,
        nonEmailBody,
        { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
        deps,
      )
    : await (async () => {
        // Email-only path: re-read the contact so the response shape
        // matches the non-email path.
        const reread = await deps.contactRepo.findById(
          tenant,
          parsed.data.contactId as ContactId,
        );
        return reread.ok
          ? { ok: true as const, value: reread.value }
          : {
              ok: false as const,
              error: { type: 'not_found' as const },
            };
      })();

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
    parsed.data.memberId as MemberId,
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
