/**
 * F9 US5 (T082b) — POST `/api/portal/directory`.
 *
 * Member self-service directory listing update (FR-025). The member is resolved
 * from the session (`findByLinkedUserId`), never the body — a member can only
 * edit their OWN listing. `updateDirectoryListing` enforces the same rule +
 * validates website/description + sanitises the visibility map, and lets only
 * the live primary contact switch the contact name / email toggles. CSRF Origin +
 * session enforced by `middleware.ts` for state-changing `/api/**`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { checkPortalAccess } from '@/lib/lapsed-portal-scope';
import { buildPortalAccessDeps, toPortalAccessAction } from '@/lib/portal-access-deps';
import { updateDirectoryListing, makeUpdateDirectoryListingDeps } from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';

export const runtime = 'nodejs';

const BodySchema = z.object({
  listed: z.boolean(),
  fieldVisibility: z.record(z.string(), z.boolean()).default({}),
  industry: z.string().max(255).nullable().default(null),
  description: z.string().max(2000).nullable().default(null),
  website: z.string().max(2048).nullable().default(null),
  locationCity: z.string().max(255).nullable().default(null),
  locationCountry: z.string().max(8).nullable().default(null),
});

const ERROR_STATUS: Record<string, number> = {
  forbidden: 403,
  member_not_found: 404,
  invalid_website: 422,
  description_too_long: 422,
  not_primary_contact: 403,
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'feature_disabled' }, correlationId }, { status: 503 });
  }
  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: { code: 'unauthorized' }, correlationId }, { status: 401 });
  }
  // rbac-portal-identity-ok: /portal/** belongs to the member subject.
  if (current.user.role !== 'member') {
    // The member self-service route is for members; staff edit via the admin surface.
    return NextResponse.json({ error: { code: 'forbidden' }, correlationId }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'invalid_body' }, correlationId }, { status: 400 });
  }

  const tenant = resolveTenantFromRequest(request);
  const membersDeps = buildMembersDeps(tenant);
  const memberResult = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    current.user.id,
  );
  if (!memberResult.ok) {
    // not_found (session user has no member profile) → 404; a DB/RLS fault must
    // surface as 500 with a log, not be masked as "no profile".
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        {
          correlationId,
          tenantId: tenant.slug,
          errCode: memberResult.error.code,
          errKind: errKind(rootCause(memberResult.error)),
        },
        'portal.directory.member_lookup_failed',
      );
      return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
    }
    return NextResponse.json({ error: { code: 'no_member_profile' }, correlationId }, { status: 404 });
  }
  const memberId = memberResult.value.memberId;

  // 059-membership-suspension Task 7b — this route resolves its member via
  // a bespoke `getCurrentSession` + `findByLinkedUserId` lookup instead of
  // `requireMemberContext` (`src/lib/member-context.ts`), so it does NOT
  // automatically inherit that helper's `checkPortalAccess` enforcement.
  // Wire the same gate directly, same deps builder + ctx shape + fail-open
  // behaviour as `requireMemberContext` (checkPortalAccess fails open
  // internally on a cyclesRepo read error, so no extra try/catch needed here).
  // `new URL(request.url).pathname` (NOT `request.nextUrl.pathname`) per the
  // same Task 3 controller note `requireMemberContext` follows — the
  // normalized literal request path.
  const actionValue = toPortalAccessAction(request.method);
  const accessDecision = await checkPortalAccess(buildPortalAccessDeps(tenant), {
    tenantId: tenant.slug,
    memberId,
    pathname: new URL(request.url).pathname,
    actorUserId: current.user.id as string,
    correlationId,
    requestId: correlationId,
    ...(actionValue ? { action: actionValue } : {}),
  });
  if (!accessDecision.allowed) {
    return NextResponse.json(
      { error: { code: 'membership_access_restricted' }, correlationId },
      { status: 403 },
    );
  }

  // GDPR Art. 6 / PDPA §19, §24 — the contact toggles publish the LIVE primary
  // contact's name + email; the use case lets only that person change them.
  // Resolve whether the caller IS the primary (same own-contact lookup as
  // /portal/contacts/invite). A read failure is a 500, never "not primary".
  const contactsResult = await membersDeps.contactRepo.listByMember(tenant, memberId);
  if (!contactsResult.ok) {
    logger.error(
      {
        correlationId,
        tenantId: tenant.slug,
        errCode: contactsResult.error.code,
        errKind: errKind(rootCause(contactsResult.error)),
      },
      'portal.directory.contact_lookup_failed',
    );
    return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
  }
  const ownContact = contactsResult.value.find(
    (c) => String(c.linkedUserId) === current.user.id && !c.removedAt,
  );

  try {
    const result = await updateDirectoryListing(
      {
        memberId,
        listed: parsed.data.listed,
        fieldVisibility: parsed.data.fieldVisibility,
        industry: parsed.data.industry,
        description: parsed.data.description,
        website: parsed.data.website,
        locationCity: parsed.data.locationCity,
        locationCountry: parsed.data.locationCountry,
      },
      {
        actorUserId: current.user.id as string,
        actorRole: 'member',
        actorMemberId: memberId,
        actorIsPrimaryContact: ownContact?.isPrimary === true,
        requestId: correlationId,
      },
      tenant,
      makeUpdateDirectoryListingDeps(tenant.slug),
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.error }, correlationId },
        { status: ERROR_STATUS[result.error] ?? 400 },
      );
    }
    return NextResponse.json({ ok: true, correlationId }, { status: 200 });
  } catch (e) {
    logger.error(
      { correlationId, tenantId: tenant.slug, errKind: errKind(e) },
      'portal.directory.update.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
  }
}
