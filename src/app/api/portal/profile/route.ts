/**
 * Portal profile API — GET + PATCH (T120).
 *
 * GET  /api/portal/profile — read own member + contacts (FR-013)
 * PATCH /api/portal/profile — edit whitelisted fields only (FR-014)
 *
 * RBAC: `member` role only; member resolved from session via
 * `requireMemberContext`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { getMember } from '@/modules/members';
import { memberSelfUpdate } from '@/modules/members/application/use-cases/member-self-update';
import { parseIdempotencyKey } from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import type { MemberId } from '@/modules/members/domain/member';

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function serialiseMember(member: {
  memberId: string;
  companyName: string;
  legalEntityType: string | null;
  country: string;
  website: string | null;
  description: string | null;
  planId: string;
  planYear: number;
  registrationDate: Date;
  registrationFeePaid: boolean;
  status: string;
  lastActivityAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    member_id: member.memberId,
    company_name: member.companyName,
    legal_entity_type: member.legalEntityType,
    country: member.country,
    website: member.website,
    description: member.description,
    plan_id: member.planId,
    plan_year: member.planYear,
    registration_date: member.registrationDate.toISOString().split('T')[0],
    registration_fee_paid: member.registrationFeePaid,
    status: member.status,
    last_activity_at: member.lastActivityAt?.toISOString() ?? null,
    created_at: member.createdAt.toISOString(),
    updated_at: member.updatedAt.toISOString(),
    // Redacted fields per contract #12: notes, override reasons omitted
  };
}

function serialiseContact(contact: {
  contactId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  roleTitle: string | null;
  preferredLanguage: string;
  isPrimary: boolean;
  dateOfBirth: Date | null;
  linkedUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    contact_id: contact.contactId,
    first_name: contact.firstName,
    last_name: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    role_title: contact.roleTitle,
    preferred_language: contact.preferredLanguage,
    is_primary: contact.isPrimary,
    date_of_birth: contact.dateOfBirth?.toISOString().split('T')[0] ?? null,
    linked_user_id: contact.linkedUserId,
    created_at: contact.createdAt.toISOString(),
    updated_at: contact.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /api/portal/profile
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const deps = buildMembersDeps(ctx.tenant);

  const result = await getMember(
    ctx.memberId,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    {
      tenant: ctx.tenant,
      memberRepo: deps.memberRepo,
      contactRepo: deps.contactRepo,
      audit: deps.audit,
    },
  );

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found' } },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: { code: 'internal', message: 'Server error' } },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ...serialiseMember(result.value.member),
    contacts: result.value.contacts
      .filter((c) => !c.removedAt)
      .map(serialiseContact),
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/portal/profile
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  // Idempotency-Key required on mutations
  const idemResult = parseIdempotencyKey(request.headers);
  if (!idemResult.ok) {
    return NextResponse.json(
      { error: { code: 'missing_idempotency_key', message: 'Idempotency-Key header required' } },
      { status: 400 },
    );
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Invalid JSON' } },
      { status: 400 },
    );
  }

  const deps = buildMembersDeps(ctx.tenant);

  const result = await memberSelfUpdate(
    {
      tenant: ctx.tenant,
      memberRepo: deps.memberRepo,
      contactRepo: deps.contactRepo,
      audit: deps.audit,
    },
    {
      memberId: ctx.memberId,
      contactId: ctx.primaryContactId,
      rawBody,
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    },
  );

  if (!result.ok) {
    switch (result.error.type) {
      case 'forbidden':
        return NextResponse.json(
          { error: { code: 'forbidden', message: result.error.reason } },
          { status: 403 },
        );
      case 'validation_error':
        return NextResponse.json(
          { error: { code: 'validation_error', details: result.error.issues } },
          { status: 400 },
        );
      case 'not_found':
        return NextResponse.json(
          { error: { code: 'not_found' } },
          { status: 404 },
        );
      default:
        logger.error(
          { error: result.error, requestId: ctx.requestId },
          'portal.profile.patch.error',
        );
        return NextResponse.json(
          { error: { code: 'internal' } },
          { status: 500 },
        );
    }
  }

  return NextResponse.json({
    ...serialiseMember(result.value.member),
    contacts: [serialiseContact(result.value.contact)],
  });
}
