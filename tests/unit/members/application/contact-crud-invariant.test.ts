/**
 * 108 T032 (US2 / FR-010, FR-011, FR-012) — the exactly-one-primary policy is
 * wired into every contact mutation that can change primacy, and it is checked
 * INSIDE the transaction that made the change.
 *
 * Why in-tx and not before: `removeContact` today reads the contact outside the
 * write transaction and refuses if it is primary. Two concurrent calls both
 * read "not primary", both proceed, and the member can end with zero primaries
 * — which, since 108 PR-A shipped, silently stops that member's receipts, void
 * notices and credit notes. The read has to happen where the write happens.
 *
 * The application policy is the layer that produces a typed 409. The deferred
 * DB trigger from migration 0293 is the backstop for bare-SQL paths and is
 * rehearsed in `tests/integration/members/primary-contact-trigger.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ __tx: true }),
  ),
}));

import {
  addContact,
  promotePrimary,
  removeContact,
} from '@/modules/members/application/use-cases/contact-crud';
import type { ContactCrudDeps } from '@/modules/members/application/use-cases/contact-crud';
import { asTenantContext } from '@/modules/tenants';
import { asContactId, type Contact } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const PRIMARY = asContactId('22222222-2222-4222-8222-222222222222');
const SECONDARY = asContactId('33333333-3333-4333-8333-333333333333');
const NEW_ID = asContactId('44444444-4444-4444-8444-444444444444');
const meta = { actorUserId: 'admin-1', requestId: 'req-inv-1' };

function contactRow(
  contactId: string,
  opts: { isPrimary?: boolean; removed?: boolean } = {},
) {
  return {
    tenantId: 'test-tenant',
    contactId,
    memberId,
    firstName: 'F',
    lastName: 'L',
    email: `c-${contactId.slice(0, 8)}@example.com`,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    isPrimary: opts.isPrimary ?? false,
    dateOfBirth: null,
    linkedUserId: null,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    removedAt: opts.removed ? new Date('2026-02-01') : null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

const addInput = {
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane@test.example',
  preferred_language: 'en' as const,
  art14_attested: true as const,
};

/**
 * `afterWrite` is what `listByMemberInTx` returns once the mutation has landed
 * — i.e. the state the in-tx policy check actually sees.
 */
function makeDeps(opts: {
  memberStatus?: 'active' | 'inactive' | 'archived';
  afterWrite: ReturnType<typeof contactRow>[];
  removeResult?: unknown;
}) {
  const memberRepo = {
    findByIdInTx: vi.fn().mockResolvedValue(
      ok({ memberId, status: opts.memberStatus ?? 'active' }),
    ),
  };
  const contactRepo = {
    findById: vi.fn().mockResolvedValue(ok(contactRow(SECONDARY))),
    listByMemberInTx: vi.fn().mockResolvedValue(ok(opts.afterWrite)),
    addInTx: vi.fn().mockResolvedValue(ok(contactRow(NEW_ID))),
    removeInTx: vi
      .fn()
      .mockResolvedValue(
        opts.removeResult ??
          ok({ contact: contactRow(SECONDARY, { removed: true }), wasPrimary: false }),
      ),
    promotePrimaryInTx: vi.fn().mockResolvedValue(
      ok({
        demoted: contactRow(PRIMARY),
        promoted: contactRow(SECONDARY, { isPrimary: true }),
      }),
    ),
  };
  const audit = { recordInTx: vi.fn().mockResolvedValue(ok(undefined)) };
  return {
    tenant,
    memberRepo,
    contactRepo,
    audit,
    idFactory: { contactId: () => NEW_ID },
  } as unknown as ContactCrudDeps;
}

describe('contact CRUD — in-tx exactly-one-primary policy (FR-012)', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('promotePrimary', () => {
    it('commits when the member ends with exactly one live primary', async () => {
      const deps = makeDeps({
        afterWrite: [contactRow(PRIMARY), contactRow(SECONDARY, { isPrimary: true })],
      });

      const result = await promotePrimary(memberId, SECONDARY, meta, deps);

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(deps.contactRepo.listByMemberInTx).toHaveBeenCalled();
    });

    it('aborts when the post-write state has two live primaries (lost race)', async () => {
      const deps = makeDeps({
        afterWrite: [
          contactRow(PRIMARY, { isPrimary: true }),
          contactRow(SECONDARY, { isPrimary: true }),
        ],
      });

      const result = await promotePrimary(memberId, SECONDARY, meta, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({
        type: 'conflict',
        reason: 'primary_contact_race',
      });
      // The audit must not claim a primary change the tx is about to roll back.
      expect(deps.audit.recordInTx).not.toHaveBeenCalled();
    });

    it('aborts when the post-write state has zero live primaries', async () => {
      const deps = makeDeps({
        afterWrite: [contactRow(PRIMARY), contactRow(SECONDARY)],
      });

      const result = await promotePrimary(memberId, SECONDARY, meta, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({
        type: 'conflict',
        reason: 'primary_contact_race',
      });
    });

    it('reads the post-write state with the SAME tx object the write used', async () => {
      const deps = makeDeps({
        afterWrite: [contactRow(PRIMARY), contactRow(SECONDARY, { isPrimary: true })],
      });

      await promotePrimary(memberId, SECONDARY, meta, deps);

      const writeTx = vi.mocked(deps.contactRepo.promotePrimaryInTx).mock.calls[0]?.[0];
      const readTx = vi.mocked(deps.contactRepo.listByMemberInTx).mock.calls[0]?.[0];
      // A global-`db` read here would run outside the tx, see the pre-write
      // state, and pass while the invariant is broken (memory: RLS bypass via
      // the pool-global db singleton).
      expect(readTx).toBe(writeTx);
    });
  });

  describe('removeContact', () => {
    it('surfaces the repo refusal to remove a primary as cannot_remove_primary', async () => {
      const deps = makeDeps({
        afterWrite: [contactRow(PRIMARY, { isPrimary: true })],
        removeResult: err({
          code: 'repo.conflict' as const,
          reason: 'cannot_remove_primary' as const,
        }),
      });

      const result = await removeContact(memberId, PRIMARY, meta, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({ type: 'cannot_remove_primary' });
    });

    it('does not decide primacy from a read taken outside the write tx', async () => {
      // The contact looked non-primary a moment ago and is primary now. The
      // stale out-of-tx read must not be what authorises the delete — the repo
      // guard must be reached and must be what refuses.
      const deps = makeDeps({
        afterWrite: [contactRow(PRIMARY, { isPrimary: true })],
        removeResult: err({
          code: 'repo.conflict' as const,
          reason: 'cannot_remove_primary' as const,
        }),
      });
      vi.mocked(deps.contactRepo.findById).mockResolvedValue(
        ok(contactRow(PRIMARY) as unknown as Contact),
      );

      const result = await removeContact(memberId, PRIMARY, meta, deps);

      expect(deps.contactRepo.removeInTx).toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({ type: 'cannot_remove_primary' });
    });

    it('aborts when removing a secondary somehow leaves zero live primaries', async () => {
      const deps = makeDeps({ afterWrite: [contactRow(SECONDARY, { removed: true })] });

      const result = await removeContact(memberId, SECONDARY, meta, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({
        type: 'conflict',
        reason: 'primary_contact_race',
      });
      expect(deps.audit.recordInTx).not.toHaveBeenCalled();
    });

    it('commits a normal secondary removal', async () => {
      const deps = makeDeps({
        afterWrite: [
          contactRow(PRIMARY, { isPrimary: true }),
          contactRow(SECONDARY, { removed: true }),
        ],
      });

      const result = await removeContact(memberId, SECONDARY, meta, deps);

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(deps.audit.recordInTx).toHaveBeenCalled();
    });
  });

  describe('addContact', () => {
    it('commits when the member still has exactly one live primary', async () => {
      const deps = makeDeps({
        afterWrite: [contactRow(PRIMARY, { isPrimary: true }), contactRow(NEW_ID)],
      });

      const result = await addContact(memberId, addInput, meta, deps);

      expect(result.ok, JSON.stringify(result)).toBe(true);
    });

    it('still lets staff add the first contact to an ARCHIVED member (FR-014 remedy)', async () => {
      // The archived + zero-primaries member is exactly the one the unarchive
      // dialog sends staff here to fix. If the policy fired on `archived` the
      // remedy would be unreachable and the member could never be restored.
      const deps = makeDeps({
        memberStatus: 'archived',
        afterWrite: [contactRow(NEW_ID)],
      });

      const result = await addContact(memberId, addInput, meta, deps);

      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  });
});
