/**
 * Spec 122 PR C (/code-review round 2) — the banner and the compose page now
 * share one cached read per request. A failed read must not take the portal
 * layout down through the banner: it renders nothing, and the compose page
 * shows the rules in full on its own.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { features: { f7Broadcasts: true }, broadcasts: {} } }));
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: vi.fn().mockResolvedValue({ user: { id: 'u1', role: 'member' } }),
}));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 't1' }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: vi.fn().mockResolvedValue({ ok: true, value: { memberId: 'm1' } }) },
  }),
}));
vi.mock('@/modules/broadcasts', () => ({
  computeQuotaCounter: vi.fn(),
  makeComputeQuotaDeps: () => ({}),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/app/(member)/portal/_components/broadcasts-acknowledgement', () => ({
  readBroadcastsAcknowledgedAt: vi.fn().mockRejectedValue(new Error('neon: connection reset')),
}));

const { MarketingAcknowledgementBanner } = await import(
  '@/app/(member)/portal/_components/marketing-acknowledgement-banner'
);

describe('the portal banner when the acknowledgement read fails', () => {
  it('renders nothing instead of failing the layout', async () => {
    await expect(MarketingAcknowledgementBanner()).resolves.toBeNull();
  });
});
