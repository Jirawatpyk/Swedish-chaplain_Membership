/**
 * 108 T041 reliability round 2, N5 — two concurrent "first contact" adds from
 * OUTSIDE the app (no member row lock) both decide `isPrimary: true`; the
 * second INSERT trips the partial unique index `contacts_one_primary_per_member`
 * (23505) at statement time. `addInTx` used to map every 23505 to
 * `contact_email_in_use` — a true refusal with a false reason ("email taken").
 * Name the constraint, name the reason.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, runInTenant: vi.fn() }));

import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
import type { TenantTx } from '@/lib/db';
import type { ContactId } from '@/modules/members/domain/contact';
import type { MemberId } from '@/modules/members/domain/member';

function txThatRejectsInsertWith(cause: unknown): TenantTx {
  const chain = {
    values: () => ({ returning: () => Promise.reject(cause) }),
  };
  // 108 PR-D (review code H1): `addInTx` first looks for a prior `self`
  // opt-out on this address so a person's own objection survives a
  // remove → re-add. The stub answers "no prior row"; the carry-over itself
  // is proved on live Neon in contact-marketing-opt-out.test.ts.
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    orderBy: () => selectChain,
    limit: () => Promise.resolve([]),
  };
  return {
    insert: () => chain,
    select: () => selectChain,
  } as unknown as TenantTx;
}

function pgUniqueViolation(constraintName: string): Error {
  return Object.assign(new Error('Failed query: insert into "contacts" …'), {
    cause: Object.assign(
      new Error(`duplicate key value violates unique constraint "${constraintName}"`),
      { code: '23505', constraint_name: constraintName },
    ),
  });
}

const draft = {
  tenantId: 'test-tenant',
  contactId: '22222222-2222-4222-8222-222222222222' as ContactId,
  memberId: '11111111-1111-4111-8111-111111111111' as MemberId,
  firstName: 'A',
  lastName: 'B',
  email: 'a@b.example' as never,
  phone: null,
  roleTitle: null,
  preferredLanguage: 'en' as const,
  isPrimary: true,
  dateOfBirth: null,
  linkedUserId: null,
  inviteBouncedAt: null,
  art14AttestedAt: new Date(),
  // 108 PR-D — `Contact.marketing` is REQUIRED; the serialiser reads it
  // without a `?.` (review types MEDIUM-3), so a fixture must carry it.
  marketing: { optedOutAt: null, source: null, byUserId: null },
  removedAt: null,
} as unknown as Parameters<typeof drizzleContactRepo.addInTx>[1];

describe('drizzleContactRepo.addInTx — unique-violation reasons', () => {
  it('a second live primary (contacts_one_primary_per_member) is primary_contact_race, not "email in use"', async () => {
    const r = await drizzleContactRepo.addInTx(
      txThatRejectsInsertWith(pgUniqueViolation('contacts_one_primary_per_member')),
      draft,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ code: 'repo.conflict', reason: 'primary_contact_race' });
  });

  it('a duplicate email (contacts_tenant_email_uniq) still reads as contact_email_in_use', async () => {
    const r = await drizzleContactRepo.addInTx(
      txThatRejectsInsertWith(pgUniqueViolation('contacts_tenant_email_uniq')),
      draft,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ code: 'repo.conflict', reason: 'contact_email_in_use' });
  });
});
