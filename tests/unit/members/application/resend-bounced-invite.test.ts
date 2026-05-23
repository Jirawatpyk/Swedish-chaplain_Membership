/**
 * Unit coverage for `resendBouncedInvite` use-case — F3 spec § Edge Cases.
 *
 * Two-phase design (see resend-bounced-invite.ts):
 *   Phase 1 (owner role, via ReissueInvitationPort): mint + enqueue.
 *   Phase 2 (chamber_app, runInTenant): clear bounced flag + audit.
 *
 * Covered:
 *   - guard paths (not_found / no_linked_user / not_bounced / already_active)
 *   - Phase 1 error mapping (user_not_found / not_pending / reissue_failed)
 *   - happy path (reissue → clear → audit, returns {contactId, invitationId})
 *   - FAIL-SAFE: Phase 2 failure (clear OR audit) still returns ok because
 *     the invitation email is already in flight (mirrors invitePortal).
 *
 * Live-Neon integration lives in
 * `tests/integration/members/invitation-bounced-edge-case.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// runInTenant stub — runs the callback with a dummy tx and returns its
// value (the Result the phase-2 body produces).
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { resendBouncedInvite } from '@/modules/members/application/use-cases/resend-bounced-invite';
import type { ResendBouncedInviteDeps } from '@/modules/members/application/use-cases/resend-bounced-invite';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';
import type { Contact } from '@/modules/members/domain/contact';
import type { Email } from '@/modules/members/domain/value-objects/email';

const tenant = asTenantContext('test-tenant');
const contactId = asContactId('22222222-2222-4222-8222-222222222222');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const userId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';

const bouncedAt = new Date('2026-05-20T10:00:00Z');

/** Build a minimal Contact with inviteBouncedAt set. */
function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    tenantId: 'test-tenant' as Contact['tenantId'],
    contactId,
    memberId,
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane@example.com' as Email,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    dateOfBirth: null,
    linkedUserId: userId as Contact['linkedUserId'],
    inviteBouncedAt: bouncedAt,
    isPrimary: false,
    removedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-05-20T10:01:00Z'),
    ...overrides,
  } as Contact;
}

type ResultLike = ReturnType<typeof ok> | ReturnType<typeof err>;

function makeDeps(
  contactOverride: Partial<Contact> = {},
  opts: {
    contactFindResult?: ResultLike;
    isUserPendingResult?: ResultLike;
    clearResult?: ResultLike;
    reissueResult?: ResultLike;
    auditResult?: ResultLike;
  } = {},
): ResendBouncedInviteDeps {
  const contact = makeContact(contactOverride);
  return {
    tenant,
    contactRepo: {
      findById: vi.fn().mockResolvedValue(opts.contactFindResult ?? ok(contact)),
      clearInviteBouncedInTx: vi
        .fn()
        .mockResolvedValue(opts.clearResult ?? ok({ affected: 1 })),
    } as unknown as ResendBouncedInviteDeps['contactRepo'],
    userEmails: {
      isUserPending: vi
        .fn()
        .mockResolvedValue(opts.isUserPendingResult ?? ok(true)),
    } as unknown as ResendBouncedInviteDeps['userEmails'],
    reissueInvitation: {
      reissue: vi.fn().mockResolvedValue(
        opts.reissueResult ?? ok({ invitationId: 'hash-of-plain-token' }),
      ),
    } as unknown as ResendBouncedInviteDeps['reissueInvitation'],
    audit: {
      recordInTx: vi.fn().mockResolvedValue(opts.auditResult ?? ok(undefined)),
    } as unknown as ResendBouncedInviteDeps['audit'],
    clock: { now: () => new Date('2026-05-22T08:00:00Z') },
  };
}

const input = {
  contactId,
  memberId: memberId as string,
  actorUserId: actorId,
  requestId: 'req-resend-1',
  locale: 'en' as const,
};

describe('resendBouncedInvite — guard paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns not_found when contactRepo.findById returns repo.not_found', async () => {
    const deps = makeDeps({}, { contactFindResult: err({ code: 'repo.not_found' }) });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
    // No mint when the contact is not found.
    expect(deps.reissueInvitation.reissue).not.toHaveBeenCalled();
  });

  it('returns not_found when memberId does not match the contact (path-param consistency)', async () => {
    const deps = makeDeps();
    const result = await resendBouncedInvite(deps, {
      contactId,
      memberId: '99999999-9999-4999-8999-999999999999',
      actorUserId: actorId,
      requestId: 'req-mismatch',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
    expect(deps.reissueInvitation.reissue).not.toHaveBeenCalled();
  });

  it('returns not_eligible/no_linked_user when contact has no linkedUserId', async () => {
    const deps = makeDeps({ linkedUserId: null });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'not_eligible') {
      expect(result.error.reason).toBe('no_linked_user');
    } else {
      throw new Error('expected not_eligible/no_linked_user');
    }
    expect(deps.reissueInvitation.reissue).not.toHaveBeenCalled();
  });

  it('returns not_eligible/not_bounced when inviteBouncedAt is null', async () => {
    const deps = makeDeps({ inviteBouncedAt: null });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'not_eligible') {
      expect(result.error.reason).toBe('not_bounced');
    } else {
      throw new Error('expected not_eligible/not_bounced');
    }
  });

  it('returns not_eligible/already_active when user is no longer pending', async () => {
    const deps = makeDeps({}, { isUserPendingResult: ok(false) });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'not_eligible') {
      expect(result.error.reason).toBe('already_active');
    } else {
      throw new Error('expected not_eligible/already_active');
    }
    // No mint when the user is already active.
    expect(deps.reissueInvitation.reissue).not.toHaveBeenCalled();
  });

  it('returns server_error when isUserPending returns repo.not_found', async () => {
    const deps = makeDeps({}, { isUserPendingResult: err({ code: 'repo.not_found' }) });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });
});

describe('resendBouncedInvite — Phase 1 (reissue) error mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps reissue user_not_found → not_found, skips phase 2', async () => {
    const deps = makeDeps({}, { reissueResult: err({ code: 'user_not_found' }) });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
    expect(deps.contactRepo.clearInviteBouncedInTx).not.toHaveBeenCalled();
  });

  it('maps reissue not_pending → not_eligible/already_active (redeem race)', async () => {
    const deps = makeDeps({}, { reissueResult: err({ code: 'not_pending' }) });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'not_eligible') {
      expect(result.error.reason).toBe('already_active');
    } else {
      throw new Error('expected not_eligible/already_active');
    }
    expect(deps.contactRepo.clearInviteBouncedInTx).not.toHaveBeenCalled();
  });

  it('maps reissue reissue_failed → server_error, skips phase 2', async () => {
    const deps = makeDeps({}, { reissueResult: err({ code: 'reissue_failed' }) });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
    expect(deps.contactRepo.clearInviteBouncedInTx).not.toHaveBeenCalled();
  });
});

describe('resendBouncedInvite — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reissues → clears flag → audits — returns ok with {contactId, invitationId}', async () => {
    const deps = makeDeps();
    const result = await resendBouncedInvite(deps, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contactId).toBe(contactId);
      expect(result.value.invitationId).toBe('hash-of-plain-token');
    }

    expect(deps.reissueInvitation.reissue).toHaveBeenCalledTimes(1);
    expect(deps.contactRepo.clearInviteBouncedInTx).toHaveBeenCalledTimes(1);
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);

    const auditCall = (deps.audit.recordInTx as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(auditCall?.[2]).toMatchObject({ type: 'member_portal_invite_queued' });
    expect(auditCall?.[2].payload).toMatchObject({
      resend: true,
      new_invitation_id: 'hash-of-plain-token',
    });
  });

  it('calls reissue with the linked userId + actor + tenant slug + locale', async () => {
    const deps = makeDeps();
    await resendBouncedInvite(deps, input);
    const reissueCall = (deps.reissueInvitation.reissue as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(reissueCall?.[0]).toMatchObject({
      userId,
      invitedByUserId: actorId,
      locale: 'en',
      tenantId: 'test-tenant',
    });
  });

  it('delivers in the recipient preferredLanguage when no locale override', async () => {
    const deps = makeDeps({ preferredLanguage: 'th' });
    // input WITHOUT a locale → falls back to contact.preferredLanguage.
    await resendBouncedInvite(deps, {
      contactId,
      memberId: memberId as string,
      actorUserId: actorId,
      requestId: 'req-resend-locale',
    });
    const reissueCall = (deps.reissueInvitation.reissue as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(reissueCall?.[0]).toMatchObject({ locale: 'th' });
  });

  it('runs Phase 1 (reissue) BEFORE Phase 2 (clear flag)', async () => {
    const order: string[] = [];
    const deps = makeDeps();
    (deps.reissueInvitation.reissue as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push('reissue');
        return ok({ invitationId: 'hash-of-plain-token' });
      },
    );
    (deps.contactRepo.clearInviteBouncedInTx as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        order.push('clear');
        return ok({ affected: 1 });
      },
    );
    await resendBouncedInvite(deps, input);
    expect(order).toEqual(['reissue', 'clear']);
  });
});

describe('resendBouncedInvite — Phase 2 fail-safe (email already in flight)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok even when clearInviteBouncedInTx fails (logs breadcrumb)', async () => {
    const deps = makeDeps({}, {
      clearResult: err({ code: 'repo.unexpected', cause: 'db down' }),
    });
    const result = await resendBouncedInvite(deps, input);
    // Email already sent in Phase 1 → do NOT surface an error to the admin.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.invitationId).toBe('hash-of-plain-token');
    expect(deps.reissueInvitation.reissue).toHaveBeenCalledTimes(1);
    // Audit not reached because the flag-clear failed first inside the tx.
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('returns ok even when audit.recordInTx fails (logs breadcrumb)', async () => {
    const deps = makeDeps({}, {
      auditResult: err({ code: 'repo.unexpected', cause: 'audit write failed' }),
    });
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(true);
    expect(deps.contactRepo.clearInviteBouncedInTx).toHaveBeenCalledTimes(1);
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
  });

  it('returns ok even when Phase 2 THROWS (e.g. runInTenant cannot connect)', async () => {
    const deps = makeDeps();
    // A throw inside the tx (not an err Result) — the email is already in
    // flight from Phase 1, so the use-case must still return ok.
    (deps.contactRepo.clearInviteBouncedInTx as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('connection acquire timeout'),
    );
    const result = await resendBouncedInvite(deps, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.invitationId).toBe('hash-of-plain-token');
    expect(deps.reissueInvitation.reissue).toHaveBeenCalledTimes(1);
  });
});
