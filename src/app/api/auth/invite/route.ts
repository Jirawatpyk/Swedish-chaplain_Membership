/**
 * POST /api/auth/invite (T128, contracts/auth-api.md § 6).
 *
 * Admin-only. Creates a pending user + invitation + sends email.
 * Optionally links the new user to an existing member record via
 * `memberId` (F1 spec § "Linkage to member records", spec.md:672-678).
 *
 * Maps Result union to HTTP:
 *   201 — { user }
 *   400 — invalid-input (including memberId+admin/manager role mismatch,
 *         or invalid memberId UUID format)
 *   401 — no-session
 *   403 — forbidden (with manager_denied_write audit emission)
 *   404 — member-not-found (memberId supplied but not visible in
 *         caller's tenant; returned as 404 to not leak existence
 *         across tenants — consistent with `get-member` pattern)
 *   409 — email-taken
 *   500 — server-error
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createUser } from '@/modules/auth';
import {
  inviteUserForMember,
  type CreateUserPort,
  type MemberId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';

const inputSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(['admin', 'manager', 'member']),
  displayName: z.string().min(1).max(120).optional(),
  locale: z.enum(['en', 'th', 'sv']).optional(),
  // F1 spec:672-678 — optional link to existing member record. Only
  // valid when role='member'. Mismatched role rejected below at 400.
  memberId: z.string().uuid().optional(),
});

// Adapt F1 createUser to the narrowed CreateUserPort the members use
// case expects (role constrained to 'member').
const createUserPort: CreateUserPort = async (input) => {
  const result = await createUser({
    email: input.email,
    role: input.role,
    displayName: input.displayName ?? null,
    actorUserId: input.actorUserId as never,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    locale: input.locale,
  });
  if (result.ok) {
    return { ok: true, value: { user: { id: result.value.user.id } } };
  }
  return { ok: false, error: { code: result.error.code } };
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request);
  if ('response' in ctx) return ctx.response;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid-input', message: 'Body must be JSON' },
      { status: 400 },
    );
  }

  const parsed = inputSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-input', message: 'Invalid request body' },
      { status: 400 },
    );
  }

  // Reject the admin/manager + memberId combination explicitly (not
  // silent-ignore) — the form should not offer memberId for non-member
  // roles, so a payload carrying both is a client bug worth surfacing
  // rather than masking.
  if (parsed.data.memberId && parsed.data.role !== 'member') {
    return NextResponse.json(
      {
        error: 'invalid-input',
        message: 'memberId is only valid for role=member',
      },
      { status: 400 },
    );
  }

  // --- Branch A: member role with optional memberId link ---
  if (parsed.data.role === 'member' && parsed.data.memberId) {
    const tenant = resolveTenantFromRequest(request);
    const deps = buildMembersDeps(tenant);

    const result = await inviteUserForMember(
      {
        tenant,
        contactRepo: deps.contactRepo,
        memberRepo: deps.memberRepo,
        audit: deps.audit,
        createUser: createUserPort,
        idFactory: deps.idFactory,
      },
      {
        memberId: parsed.data.memberId as MemberId,
        email: parsed.data.email,
        displayName: parsed.data.displayName ?? null,
        actorUserId: ctx.current.user.id,
        sourceIp: ctx.sourceIp,
        requestId: ctx.requestId,
        locale: parsed.data.locale,
      },
    );

    if (result.ok) {
      return NextResponse.json(
        {
          user: {
            id: result.value.userId,
            email: result.value.email,
            role: 'member',
            status: 'pending',
            displayName: parsed.data.displayName ?? null,
          },
          contactId: result.value.contactId,
        },
        { status: 201 },
      );
    }

    const { error } = result;
    switch (error.type) {
      case 'invalid_email':
        return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
      case 'email_taken':
        return NextResponse.json({ error: 'email-taken' }, { status: 409 });
      case 'member_not_found':
        // 404 (not 403) to avoid leaking whether the memberId exists
        // in a sibling tenant — consistent with `get-member` pattern.
        return NextResponse.json(
          { error: 'member-not-found' },
          { status: 404 },
        );
      default:
        logger.error(
          { requestId: ctx.requestId, err: error },
          'invite.member_link.server_error',
        );
        return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }

  // --- Branch B: existing F1 flow (no memberId, or non-member role) ---
  const result = await createUser({
    email: parsed.data.email,
    role: parsed.data.role,
    displayName: parsed.data.displayName ?? null,
    actorUserId: ctx.current.user.id,
    sourceIp: ctx.sourceIp,
    requestId: ctx.requestId,
    locale: parsed.data.locale,
  });

  if (result.ok) {
    const { user } = result.value;
    return NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          status: user.status,
          displayName: user.displayName,
        },
      },
      { status: 201 },
    );
  }

  const { error } = result;
  switch (error.code) {
    case 'invalid-input':
      return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
    case 'email-taken':
      return NextResponse.json({ error: 'email-taken' }, { status: 409 });
    default: {
      logger.error(
        { requestId: ctx.requestId },
        'invite: unhandled error variant',
      );
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
