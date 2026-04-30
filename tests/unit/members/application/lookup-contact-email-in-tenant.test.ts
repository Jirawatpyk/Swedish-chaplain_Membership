/**
 * Unit tests for `lookupContactEmailInTenant` use case (T029, F7 Batch C).
 *
 * Validates email format → calls `contactRepo.findByEmail` → returns
 * a domain-typed projection. Tests cover invalid email (returns null),
 * not-found (returns null), found (returns projection), repo errors.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { lookupContactEmailInTenant } from '@/modules/members/application/use-cases/lookup-contact-email-in-tenant';

const tenant = asTenantContext('test-tenant');

function makeContact(email: string) {
  return {
    tenantId: 'test-tenant' as never,
    contactId: 'c1' as never,
    memberId: 'm1' as never,
    firstName: 'Alice',
    lastName: 'Doe',
    email: email as never,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en' as never,
    dateOfBirth: null,
    isPrimary: true,
    linkedUserId: null,
    removedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

describe('lookupContactEmailInTenant', () => {
  it('returns null on invalid email format (asEmail rejects)', async () => {
    const contactRepo = {
      findByEmail: vi.fn(),
    } as unknown as Parameters<typeof lookupContactEmailInTenant>[0]['contactRepo'];

    const result = await lookupContactEmailInTenant(
      { tenant, contactRepo },
      'not-an-email',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
    expect(contactRepo.findByEmail).not.toHaveBeenCalled();
  });

  it('returns null when contact not found', async () => {
    const contactRepo = {
      findByEmail: vi.fn().mockResolvedValue(err({ code: 'repo.not_found' })),
    } as unknown as Parameters<typeof lookupContactEmailInTenant>[0]['contactRepo'];

    const result = await lookupContactEmailInTenant(
      { tenant, contactRepo },
      'nope@example.com',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('returns projection when contact is found', async () => {
    const contactRepo = {
      findByEmail: vi.fn().mockResolvedValue(ok(makeContact('a@example.com'))),
    } as unknown as Parameters<typeof lookupContactEmailInTenant>[0]['contactRepo'];

    const result = await lookupContactEmailInTenant(
      { tenant, contactRepo },
      'a@example.com',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        memberId: 'm1',
        contactId: 'c1',
        emailLower: 'a@example.com',
      });
    }
  });

  it('propagates non-not_found repo error', async () => {
    const contactRepo = {
      findByEmail: vi
        .fn()
        .mockResolvedValue(err({ code: 'repo.unexpected', cause: 'boom' })),
    } as unknown as Parameters<typeof lookupContactEmailInTenant>[0]['contactRepo'];

    const result = await lookupContactEmailInTenant(
      { tenant, contactRepo },
      'a@example.com',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });
});
