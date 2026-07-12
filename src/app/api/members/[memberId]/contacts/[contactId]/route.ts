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
  updateUnlinkedContactEmail,
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
  // Post-ship R6 Batch 2b — surface Upstash outage as 503 instead of
  // silently continuing. Mirrors `_idempotency-guard.ts:106-125` from
  // Batch 1d. Contact mutations split between simple update + atomic
  // email-change tx; either path is a write we want exactly-once
  // semantics on.
  const reserved = await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);
  if (!reserved.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'idempotency_reservation_failed',
          message:
            'Idempotency reservation temporarily unavailable. Retry shortly.',
        },
      },
      { status: 503, headers: { 'Retry-After': '5' } },
    );
  }

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

  // Captures the contact value an in-place UNLINKED email update already
  // returns (section 1) so section 2 can build the response WITHOUT a re-read.
  // Stays null for the linked path (changeContactEmail returns a verification
  // output, not a Contact) → section 2 re-reads for that case only.
  let emailUpdatedContact: Parameters<typeof serialiseContact>[0] | null = null;
  // True once section 1 has COMMITTED an email change (either path). Section 2
  // uses it to surface a partial save: if the non-email field update then fails
  // we must not return a bare error that hides the already-committed email (a
  // fresh-key retry would re-emit the email audit) — see the partial-save
  // branch below.
  let emailChangeCommitted = false;

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

    // SEC-3 parity: the unlinked + non-email paths reject a member/contact
    // mismatch internally (they check `existing.memberId !== memberId`);
    // changeContactEmail keys on contactId ONLY, so guard the linked
    // email-change branch here too — a mismatched member URL must never drive
    // a linked contact's email change (session revoke + verify/revert emails)
    // under the wrong member. Same-tenant + admin-gated, but the lone
    // asymmetric path.
    if (contact.memberId !== (parsed.data.memberId as MemberId)) {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Contact not found.' } },
        { status: 404 },
      );
    }

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
          audit: deps.audit,
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
      // Linked email change committed (session revoke + verify/revert emails).
      emailChangeCommitted = true;
    } else {
      // No linked user — the email is a plain contact field (not a login
      // identity), so update it in place. The FR-012a atomic flow above is
      // only needed when the address is also a portal login. (Imported
      // members are never invited, so their contacts are always unlinked.)
      const emailUpdate = await updateUnlinkedContactEmail(
        parsed.data.memberId as MemberId,
        parsed.data.contactId as ContactId,
        emailValue,
        { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
        deps,
      );
      if (!emailUpdate.ok) {
        switch (emailUpdate.error.type) {
          case 'invalid_email':
            return NextResponse.json(
              {
                error: {
                  code: 'validation_error',
                  message: 'Invalid email address.',
                  details: { field: 'email' },
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
                  reason: emailUpdate.error.reason,
                },
              },
              { status: 409 },
            );
          default:
            logger.error(
              { requestId: ctx.requestId, err: emailUpdate.error },
              'update-unlinked-contact-email: unhandled',
            );
            return NextResponse.json(
              { error: { code: 'server_error', message: 'Internal server error.' } },
              { status: 500 },
            );
        }
      }
      // Reuse the value the in-tx update already returned so section 2 need
      // not re-read: a post-commit re-read whose transient failure mapped to
      // not_found would return a misleading 404 for a committed change AND
      // skip rememberIdempotentResponse, letting a fresh-key retry duplicate
      // the append-only contact_updated audit row.
      emailUpdatedContact = emailUpdate.value;
      emailChangeCommitted = true;
    }
  }

  // 2) Non-email fields (if present), or an email-only edit whose value we
  //    already hold from section 1 (unlinked path), otherwise a re-read for
  //    the response shape (linked path only).
  const result = hasNonEmail
    ? await updateContactFields(
        parsed.data.memberId as MemberId,
        parsed.data.contactId as ContactId,
        nonEmailBody,
        { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
        deps,
      )
    : emailUpdatedContact !== null
      ? { ok: true as const, value: emailUpdatedContact }
      : await (async () => {
          // Email-only LINKED path: changeContactEmail returns a verification
          // output (not a Contact), so re-read for the response shape. A
          // transient re-read failure AFTER a committed change is a 500 (the
          // contact provably exists), never a misleading 404.
          const reread = await deps.contactRepo.findById(
            tenant,
            parsed.data.contactId as ContactId,
          );
          return reread.ok
            ? { ok: true as const, value: reread.value }
            : {
                ok: false as const,
                error: {
                  type: 'server_error' as const,
                  message: 'post-email-change re-read failed',
                },
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

  // Partial save: section 1 (email) COMMITTED but section 2 (non-email fields)
  // failed. The two use-cases have separate audit + tx boundaries, so we can't
  // roll the email back here. Returning the bare section-2 error would hide the
  // committed email from the admin AND a fresh-key retry would re-emit the email
  // audit. Instead respond 200 with the email-updated contact plus a top-level
  // `field_update_failed` marker (existing success consumers read the contact
  // fields and ignore it) so the client can prompt a retry of just the fields.
  if (hasNonEmail && emailChangeCommitted) {
    // The unlinked path already holds the committed contact; the linked path
    // re-reads once (a re-read failure degrades to the normal error below).
    let committed = emailUpdatedContact;
    if (committed === null) {
      const reread = await deps.contactRepo.findById(
        tenant,
        parsed.data.contactId as ContactId,
      );
      if (reread.ok) committed = reread.value;
    }
    if (committed !== null) {
      const body = {
        ...serialiseContact(committed),
        field_update_failed: result.error.type,
      };
      // Persist the 200 so a fresh-key retry replays it rather than re-running
      // (and re-auditing) the committed email change.
      await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
        status: 200,
        body,
      });
      return NextResponse.json(body, { status: 200 });
    }
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
