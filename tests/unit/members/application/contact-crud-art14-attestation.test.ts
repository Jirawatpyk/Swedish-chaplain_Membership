/**
 * Task 8 — GDPR Art. 14 attestation gate on `addContact` (contact-crud.ts).
 *
 * Every contact added through this use case is non-primary (isPrimary is
 * hardcoded false) — a named third party whose data the admin is
 * supplying, not the person themselves. The admin must attest they
 * informed that person before this write is allowed to proceed:
 *   - `addContactSchema` rejects the call outright (schema-level, before
 *     any repo/tx call) unless `art14_attested` is the literal `true`.
 *   - On the happy path, the draft passed to `ContactRepo.addInTx` carries
 *     a real `art14AttestedAt` timestamp (never `null` — this use case
 *     never creates a primary contact).
 *
 * Live-Neon end-to-end coverage (DB round-trip) lives in
 * `tests/integration/members/contact-art14-attestation.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

import {
  addContact,
  addContactSchema,
} from '@/modules/members/application/use-cases/contact-crud';
import type { ContactCrudDeps } from '@/modules/members/application/use-cases/contact-crud';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const contactId = asContactId('22222222-2222-4222-8222-222222222222');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-art14-001' };

const validInputBase = {
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane@test.example',
  preferred_language: 'en' as const,
};

describe('addContactSchema — GDPR Art. 14 attestation gate (Task 8)', () => {
  it('rejects when art14_attested is missing', () => {
    const result = addContactSchema.safeParse(validInputBase);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'art14_attested'),
      ).toBe(true);
    }
  });

  it('rejects when art14_attested is false', () => {
    const result = addContactSchema.safeParse({
      ...validInputBase,
      art14_attested: false,
    });
    expect(result.success).toBe(false);
  });

  it('accepts when art14_attested is true', () => {
    const result = addContactSchema.safeParse({
      ...validInputBase,
      art14_attested: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('addContact — GDPR Art. 14 attestation gate (Task 8)', () => {
  function makeDeps(): { deps: ContactCrudDeps; addInTx: ReturnType<typeof vi.fn> } {
    const addInTx = vi.fn().mockImplementation(async (_tx, draft) =>
      ok({
        ...draft,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const deps: ContactCrudDeps = {
      tenant,
      contactRepo: {
        addInTx,
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
        recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
      },
      idFactory: { contactId: () => contactId },
    };
    return { deps, addInTx };
  }

  beforeEach(() => vi.clearAllMocks());

  it('refuses the request BEFORE touching the repo when art14_attested is missing', async () => {
    const { deps, addInTx } = makeDeps();
    const result = await addContact(memberId, validInputBase, meta, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
    expect(addInTx).not.toHaveBeenCalled();
  });

  it('refuses the request when art14_attested is false (not just falsy/missing)', async () => {
    const { deps, addInTx } = makeDeps();
    const result = await addContact(
      memberId,
      { ...validInputBase, art14_attested: false },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
    expect(addInTx).not.toHaveBeenCalled();
  });

  it('stamps a real art14AttestedAt timestamp on the draft when attested', async () => {
    const { deps, addInTx } = makeDeps();
    const before = Date.now();
    const result = await addContact(
      memberId,
      { ...validInputBase, art14_attested: true },
      meta,
      deps,
    );
    const after = Date.now();
    expect(result.ok).toBe(true);
    expect(addInTx).toHaveBeenCalledTimes(1);
    const draft = addInTx.mock.calls[0]![1] as {
      art14AttestedAt: Date;
      isPrimary: boolean;
    };
    expect(draft.isPrimary).toBe(false);
    expect(draft.art14AttestedAt).toBeInstanceOf(Date);
    expect(draft.art14AttestedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(draft.art14AttestedAt.getTime()).toBeLessThanOrEqual(after);
  });
});
