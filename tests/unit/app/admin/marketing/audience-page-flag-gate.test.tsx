/**
 * 108 PR-D review cycle 14 (whole-branch MEDIUM-11) — /admin/marketing/audience
 * is hidden from the nav and the ⌘K palette when `FEATURE_F7_BROADCASTS` is
 * off, so the PAGE must 404 too (the convention `src/config/nav.ts` states
 * for `/admin/events`): a hidden page that still serves on its URL is a
 * one-sided gate. The check runs right after the permission gate and before
 * any data read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above every top-level statement — the
// mutable handles they close over must be hoisted with them.
const { features, requirePagePermission, buildMarketingAudienceDeps, listMarketingAudience } =
  vi.hoisted(() => ({
    features: { f7Broadcasts: true },
    requirePagePermission: vi.fn(),
    buildMarketingAudienceDeps: vi.fn(),
    listMarketingAudience: vi.fn(),
  }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: (...args: unknown[]) => requirePagePermission(...args),
  canPerform: () => true,
}));
vi.mock('@/lib/env', () => ({ env: { features } }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/lib/contact-marketing-deps', () => ({
  buildMarketingAudienceDeps: (...args: unknown[]) => buildMarketingAudienceDeps(...args),
}));
vi.mock('@/modules/members', () => ({
  listMarketingAudience: (...args: unknown[]) => listMarketingAudience(...args),
}));
vi.mock('@/modules/auth', () => ({ resolveActorIdentities: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('@/lib/format-date-localised', () => ({ formatLocalisedDate: () => 'date' }));

import MarketingAudiencePage from '@/app/(staff)/admin/marketing/audience/page';

beforeEach(() => {
  features.f7Broadcasts = true;
  requirePagePermission.mockReset().mockResolvedValue({ user: { role: 'admin' } });
  listMarketingAudience.mockReset();
  buildMarketingAudienceDeps.mockReset();
});

describe('/admin/marketing/audience — F7 flag gate', () => {
  it('FEATURE_F7_BROADCASTS off → notFound() after the permission gate, before any read', async () => {
    features.f7Broadcasts = false;
    await expect(
      MarketingAudiencePage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(requirePagePermission).toHaveBeenCalledWith('contacts.read');
    expect(listMarketingAudience).not.toHaveBeenCalled();
    expect(buildMarketingAudienceDeps).not.toHaveBeenCalled();
  });

  it('flag on → the page renders (no notFound)', async () => {
    const el = await MarketingAudiencePage({ searchParams: Promise.resolve({}) });
    expect(el).toBeTruthy();
  });
});
