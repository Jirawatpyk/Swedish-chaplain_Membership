/**
 * Unit: updateContactFields — Thai Alumni date_of_birth acceptance + mapping.
 *
 * Regression for the "edit DOB doesn't save" bug: `updateContactFieldsSchema`
 * used to omit `date_of_birth` (a `.strict()` object), so any PATCH carrying it
 * was rejected 400 AND the use case never wrote it. These tests lock in that
 * (1) the schema accepts `date_of_birth`, and (2) the use case threads it to the
 * repo `updateInTx` patch as a `Date` (or `null` to clear).
 *
 * `runInTenant` is stubbed (invokes the callback with a dummy tx) — the same
 * shape as w1-tx-rollback.test.ts. The real `date`-column serialisation lives in
 * drizzle-contact-repo `updateInTx` (integration territory).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { updateContactFields } from '@/modules/members/application/use-cases/contact-crud';
import type { ContactCrudDeps } from '@/modules/members/application/use-cases/contact-crud';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const contactId = asContactId('22222222-2222-4222-8222-222222222222');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-dob-001' };

const existing = {
  tenantId: tenant.slug as never,
  contactId,
  memberId,
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@test.example' as never,
  phone: null,
  roleTitle: null,
  preferredLanguage: 'en' as const,
  isPrimary: true,
  dateOfBirth: null,
  linkedUserId: null,
  removedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeDeps() {
  const updateInTx = vi.fn().mockResolvedValue(ok({ ...existing }));
  const deps = {
    tenant,
    contactRepo: {
      findById: vi.fn().mockResolvedValue(ok(existing)),
      updateInTx,
      addInTx: vi.fn(),
      removeInTx: vi.fn(),
      linkUserInTx: vi.fn(),
      promotePrimaryInTx: vi.fn(),
      updateEmailInTx: vi.fn(),
      listLinkedUserIdsForMemberInTx: vi.fn(),
      listByMember: vi.fn(),
    } as unknown as ContactCrudDeps['contactRepo'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
    },
    idFactory: { contactId: () => contactId },
  } as unknown as ContactCrudDeps;
  return { deps, updateInTx };
}

describe('updateContactFields — date_of_birth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts date_of_birth and threads it to the repo patch as a Date', async () => {
    const { deps, updateInTx } = makeDeps();
    const result = await updateContactFields(
      memberId,
      contactId,
      { date_of_birth: '2000-01-15' },
      meta,
      deps,
    );
    expect(result.ok).toBe(true);
    const patch = updateInTx.mock.calls[0]?.[2] as { dateOfBirth?: unknown };
    expect(patch.dateOfBirth).toBeInstanceOf(Date);
    expect((patch.dateOfBirth as Date).toISOString().slice(0, 10)).toBe(
      '2000-01-15',
    );
  });

  it('maps an empty string to null (clears the stored DOB)', async () => {
    const { deps, updateInTx } = makeDeps();
    const result = await updateContactFields(
      memberId,
      contactId,
      { date_of_birth: '' },
      meta,
      deps,
    );
    expect(result.ok).toBe(true);
    const patch = updateInTx.mock.calls[0]?.[2] as { dateOfBirth?: unknown };
    expect(patch.dateOfBirth).toBeNull();
  });

  it('leaves dateOfBirth absent from the patch when not supplied', async () => {
    const { deps, updateInTx } = makeDeps();
    await updateContactFields(
      memberId,
      contactId,
      { first_name: 'Janet' },
      meta,
      deps,
    );
    const patch = updateInTx.mock.calls[0]?.[2] as Record<string, unknown>;
    expect('dateOfBirth' in patch).toBe(false);
  });
});
