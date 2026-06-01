/**
 * Unit — invitePortal SAGA compensation (go-live /code-review #12-13).
 *
 * The orphan window: F1 `createUser` commits a pending user (+ invitation +
 * queued email) in its own owner-role tx; the contact link then runs in a
 * SEPARATE chamber_app tx. If the link FAILS after createUser committed, the
 * pre-fix code returned ok() and left a PERMANENT orphan (an active user whose
 * contact is never linked → broken member-portal resolution). The fix rolls the
 * invite back via `deleteInvitedUser` and returns `link_failed`.
 *
 * These tests assert:
 *   - happy path → ok(); compensation NEVER fires.
 *   - link failure → `deleteInvitedUser` called with the exact userId+outboxRowId
 *     from createUser, then `link_failed` returned (NOT ok — no silent orphan).
 *   - compensation itself failing → still `link_failed` (logged); the use case
 *     never throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

// runInTenant(ctx, fn) — invoke fn with a fake tx so linkUserInTx runs.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({} as never)),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { invitePortal, type InvitePortalDeps } from '@/modules/members/application/use-cases/invite-portal';
import type { ContactId } from '@/modules/members/domain/contact';
import { logger } from '@/lib/logger';

const CONTACT_ID = '22222222-2222-2222-2222-222222222222' as ContactId;
const NEW_USER_ID = 'usr-new-1';
const OUTBOX_ROW_ID = 'outbox-row-1';

const tenant = { slug: 'test-tenant' } as unknown as InvitePortalDeps['tenant'];

const contact = {
  contactId: CONTACT_ID,
  email: 'invitee@swecham.test',
  firstName: 'Inga',
  lastName: 'Test',
  preferredLanguage: 'en' as const,
  linkedUserId: null,
  isPrimary: true,
};

function makeDeps(overrides: Partial<InvitePortalDeps> = {}): {
  deps: InvitePortalDeps;
  createUser: ReturnType<typeof vi.fn>;
  linkUserInTx: ReturnType<typeof vi.fn>;
  deleteInvitedUser: ReturnType<typeof vi.fn>;
} {
  const createUser = vi.fn(async () => ok({ user: { id: NEW_USER_ID }, outboxRowId: OUTBOX_ROW_ID }));
  const linkUserInTx = vi.fn(async () => ok(undefined));
  const deleteInvitedUser = vi.fn(async () => ({ ok: true }));
  const deps: InvitePortalDeps = {
    tenant,
    contactRepo: {
      findById: vi.fn(async () => ok(contact)),
      linkUserInTx,
    } as unknown as InvitePortalDeps['contactRepo'],
    createUser: createUser as unknown as InvitePortalDeps['createUser'],
    deleteInvitedUser: deleteInvitedUser as unknown as InvitePortalDeps['deleteInvitedUser'],
    ...overrides,
  };
  return { deps, createUser, linkUserInTx, deleteInvitedUser };
}

const input = {
  contactId: CONTACT_ID,
  actorUserId: 'admin-1',
  sourceIp: '203.0.113.5',
  requestId: 'req-invite-1',
};

beforeEach(() => vi.clearAllMocks());

describe('invitePortal — happy path', () => {
  it('links the contact and returns ok; compensation NEVER fires', async () => {
    const { deps, deleteInvitedUser } = makeDeps();
    const result = await invitePortal(deps, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.userId).toBe(NEW_USER_ID);
    expect(deleteInvitedUser).not.toHaveBeenCalled();
  });
});

describe('invitePortal — SAGA compensation on link failure (#12-13)', () => {
  it('link fails → rolls back the invite via deleteInvitedUser, returns link_failed', async () => {
    const { deps, deleteInvitedUser } = makeDeps({
      contactRepo: {
        findById: vi.fn(async () => ok(contact)),
        linkUserInTx: vi.fn(async () => err({ code: 'repo.unexpected' })),
      } as unknown as InvitePortalDeps['contactRepo'],
    });

    const result = await invitePortal(deps, input);

    // No silent ok() — the orphan-producing branch now surfaces a typed failure.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('link_failed');
    // Compensation deletes the EXACT just-created user + its queued email.
    expect(deleteInvitedUser).toHaveBeenCalledOnce();
    expect(deleteInvitedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: NEW_USER_ID,
        outboxRowId: OUTBOX_ROW_ID,
        targetEmail: contact.email,
        requestId: 'req-invite-1',
      }),
    );
  });

  it('compensation ALSO failing → still link_failed (logged); never throws out', async () => {
    const { deps } = makeDeps({
      contactRepo: {
        findById: vi.fn(async () => ok(contact)),
        linkUserInTx: vi.fn(async () => err({ code: 'repo.unexpected' })),
      } as unknown as InvitePortalDeps['contactRepo'],
      deleteInvitedUser: vi.fn(async () => ({ ok: false })) as unknown as InvitePortalDeps['deleteInvitedUser'],
    });

    const result = await invitePortal(deps, input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('link_failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-invite-1' }),
      'invite-portal.compensation_failed: orphan persists — manual reconciliation needed',
    );
  });
});
