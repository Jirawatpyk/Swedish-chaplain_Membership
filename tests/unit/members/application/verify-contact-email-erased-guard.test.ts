/**
 * Unit test — `verifyContactEmail` refuses a disabled / missing login (134-s1).
 *
 * The revert sink already refuses an erased login (revert-contact-email-erased-
 * guard.test.ts). Verification flips `users.email_verified` on the token's
 * user, so a verification token that survived for an erased (`disabled`) login
 * must be refused the same way: a typed `not_found` (the public token route's
 * enumeration-safe answer), with the token left unconsumed and no flag written.
 *
 * Mocked `runInTenant` invokes the fn with a bare `{}` tx — the use case talks
 * to ports only. The F8 hook is off (`env.features.f8Renewals = false`).
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: never) => unknown) => fn({} as never),
}));
vi.mock('@/lib/env', () => ({ env: { features: { f8Renewals: false } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({ renewalsMetrics: { resetHookFailed: vi.fn() } }));
vi.mock('@/modules/renewals', () => ({
  resetEmailUnverified: vi.fn(),
  makeRenewalsDeps: vi.fn(),
  lookupMemberByContactId: vi.fn(),
}));

const { verifyContactEmail } = await import(
  '@/modules/members/application/use-cases/verify-contact-email'
);
type VerifyDeps = Parameters<typeof verifyContactEmail>[0];

const ACTIVE_VERIFICATION_TOKEN = {
  tokenId: 'tok-1',
  tenantId: 't-1',
  contactId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  type: 'verification' as const,
  oldEmail: 'old@example.com',
  newEmail: 'new@example.com',
  activatedAt: new Date('2026-06-16T00:00:00.000Z'),
  expiresAt: new Date('2026-06-19T00:00:00.000Z'),
};

function buildDeps(status: unknown) {
  const deps = {
    tenant: { slug: 't-1' },
    tokens: {
      findActiveByIdInTx: vi.fn(async () => ok(ACTIVE_VERIFICATION_TOKEN)),
      markConsumedInTx: vi.fn(async () => ok(undefined)),
      invalidateActiveForUserInTx: vi.fn(async () => ok({ invalidatedCount: 0 })),
    },
    userEmails: {
      setFlagsInTx: vi.fn(async () => ok(undefined)),
      readStatusInTx: vi.fn(async () => status),
    },
    audit: { recordInTx: vi.fn(async () => ok(undefined)) },
    clock: { now: () => new Date('2026-06-17T00:00:00.000Z') },
  };
  return deps;
}

describe('verifyContactEmail — disabled/missing-login guard (134-s1)', () => {
  it.each([
    ['disabled (erased)', ok({ status: 'disabled' as const })],
    ['missing', ok(null)],
  ])('refuses a %s login with not_found and writes nothing', async (_label, status) => {
    const deps = buildDeps(status);
    const res = await verifyContactEmail(deps as unknown as VerifyDeps, {
      tokenId: 'tok-1',
      requestId: 'req-1',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_found');
    expect(deps.tokens.markConsumedInTx).not.toHaveBeenCalled();
    expect(deps.userEmails.setFlagsInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('still verifies an active login', async () => {
    const deps = buildDeps(ok({ status: 'active' as const }));
    const res = await verifyContactEmail(deps as unknown as VerifyDeps, {
      tokenId: 'tok-1',
      requestId: 'req-1',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(deps.userEmails.readStatusInTx).toHaveBeenCalled();
    expect(deps.userEmails.setFlagsInTx).toHaveBeenCalled();
  });
});
