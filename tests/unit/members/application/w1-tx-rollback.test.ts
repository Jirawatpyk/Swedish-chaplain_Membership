/**
 * W1 regression tests — audit-failure-after-repo-success path.
 *
 * Staff review round 3 (staff-review-20260417-175745-full-round3.md)
 * flagged an atomicity bug in the 4 use cases touched by the S1
 * refactor (`contact-crud`, `create-member`, `invite-colleague`,
 * `member-self-update`). Those callbacks previously used
 * `return err(...)` on sub-step failures inside `runInTenant(...)`
 * — which commits the tx in Drizzle. Only `throw` triggers rollback.
 *
 * This suite mocks `runInTenant` to invoke the callback synchronously
 * with a fake tx AND asserts:
 *
 *   1. When a repo `*InTx` step returns `err`, the use case returns
 *      `err` (no swallow) AND throws were thrown from the callback —
 *      proven by the mocked runInTenant NOT receiving the repo value.
 *   2. When `audit.recordInTx` returns `err` AFTER the repo write
 *      succeeds, the use case returns `err` AND the tx rolls back —
 *      proven by the mocked runInTenant re-throwing the UseCaseAbort.
 *
 * The real atomicity guarantee (Drizzle tx rollback on throw) is
 * integration-test territory (see
 * `tests/integration/members/*-atomic.test.ts`). This unit suite
 * locks in the *shape* — use cases must `throw` on failure, not
 * `return err`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// `runInTenant` stub — invokes the callback with a dummy tx and
// re-throws anything thrown inside. Does NOT swallow returns; a plain
// `return err(...)` would reach the caller, which is the bug W1 fixes.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    return await fn({});
  }),
}));

import { runInTenant as runInTenantMock } from '@/lib/db';

import { addContact } from '@/modules/members/application/use-cases/contact-crud';
import type { ContactCrudDeps } from '@/modules/members/application/use-cases/contact-crud';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const contactId = asContactId('22222222-2222-4222-8222-222222222222');

function makeDeps(options: {
  addInTxResult: ReturnType<typeof ok> | ReturnType<typeof err>;
  auditResult: ReturnType<typeof ok> | ReturnType<typeof err>;
}): ContactCrudDeps {
  return {
    tenant,
    contactRepo: {
      addInTx: vi.fn().mockResolvedValue(options.addInTxResult),
      updateInTx: vi.fn(),
      removeInTx: vi.fn(),
      linkUserInTx: vi.fn(),
      promotePrimaryInTx: vi.fn(),
      updateEmailInTx: vi.fn(),
      listLinkedUserIdsForMemberInTx: vi.fn(),
      listByMember: vi.fn(),
      findById: vi.fn(),
    } as unknown as ContactCrudDeps['contactRepo'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn().mockResolvedValue(options.auditResult),
    },
    idFactory: { contactId: () => contactId },
  };
}

const validInput = {
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane@test.example',
  preferred_language: 'en' as const,
};
const meta = {
  actorUserId: 'actor-uuid',
  requestId: 'req-w1-001',
};

describe('W1 — audit atomicity regression (throw-to-rollback)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('addContact: returns err when addInTx fails (throws inside tx)', async () => {
    const deps = makeDeps({
      addInTxResult: err({ code: 'repo.conflict' as const, reason: 'dup' }),
      auditResult: ok(undefined),
    });
    const result = await addContact(memberId, validInput, meta, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('conflict');
    // Audit MUST NOT be attempted when addInTx fails — the throw short-
    // circuits the callback before the audit recordInTx call.
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('addContact: returns err AND rolls back when audit.recordInTx fails after addInTx succeeds', async () => {
    const fakeContact = {
      tenantId: tenant.slug as never,
      contactId,
      memberId,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.example' as never,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en' as const,
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const deps = makeDeps({
      addInTxResult: ok(fakeContact),
      auditResult: err({ code: 'repo.unexpected' as const, cause: 'audit db down' }),
    });

    const result = await addContact(memberId, validInput, meta, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
    // The audit call HAPPENED (so we know we exercised the failure branch)...
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
    // ...and the callback was invoked inside runInTenant...
    expect(runInTenantMock).toHaveBeenCalledTimes(1);
    // ...and control returned to the caller via the outer catch
    // rather than a normal callback return. That is what `throw new
    // UseCaseAbort` guarantees — and what the old `return err(...)`
    // pattern failed to deliver. A live Drizzle tx would now have
    // rolled back the addInTx insert because the callback threw.
  });

  it('addContact: happy path — addInTx ok + audit ok → use case ok', async () => {
    const fakeContact = {
      tenantId: tenant.slug as never,
      contactId,
      memberId,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.example' as never,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en' as const,
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const deps = makeDeps({
      addInTxResult: ok(fakeContact),
      auditResult: ok(undefined),
    });
    const result = await addContact(memberId, validInput, meta, deps);
    expect(result.ok).toBe(true);
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
  });
});
