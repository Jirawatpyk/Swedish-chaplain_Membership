/**
 * 059-membership-suspension Task 9 item 5 — `/portal/broadcasts/new`
 * page-level redirect for a suspended/terminated member.
 *
 * `enforcePortalPageAccess` (member shell layout) already blocks this route
 * on SSR load/refresh, but Next.js 16 does NOT re-run a layout on
 * client-side navigation between sibling portal routes — so the compose
 * page needs its own check too (same rationale as the pre-existing FR-009
 * `cap === 0` bounce it now shares a redirect target with).
 *
 * This test also pins the redirect-outside-try/catch fix: `redirect()`
 * throws a special Next.js control-flow error that a broad `catch` would
 * otherwise swallow (see `src/lib/portal-page-access.ts`'s identical
 * caveat) — if either redirect were still nested inside the try block, the
 * mocked `redirect()` throw would be caught by the page's own `catch (err)`
 * and the assertions below would see `redirect` called but the returned
 * promise would NOT reject, since the page would swallow the throw and
 * continue rendering instead of propagating it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect }));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/db', () => ({ runInTenant: vi.fn(async (_ctx, fn: () => unknown) => fn()) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const loadMembershipAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/load-membership-access', () => ({ loadMembershipAccess }));

const findByLinkedUserId = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { memberId: 'm1' } }),
);
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findByLinkedUserId } }),
}));

const computeQuotaCounter = vi.hoisted(() => vi.fn());
vi.mock('@/modules/broadcasts', () => ({
  computeQuotaCounter,
  envTenantDisplayName: { resolve: vi.fn() },
  f7AuditAdapter: {},
  isF71aUs7Enabled: () => false,
  listBroadcastTemplates: vi.fn(),
  makeComputeQuotaDeps: () => ({}),
  makeListBroadcastTemplatesDeps: () => ({}),
  substituteChamberName: (s: string) => s,
}));
vi.mock('@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo', () => ({
  makeDrizzleBroadcastTemplatesRepo: () => ({}),
}));
vi.mock('@/modules/broadcasts/application/use-cases/_safe-audit-emit', () => ({
  safeAuditEmit: vi.fn(),
}));
vi.mock('@/modules/broadcasts/infrastructure/feature-flags', () => ({
  isF71aUs2Enabled: () => false,
}));

vi.mock('@/components/layout', () => ({
  FormContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: () => <div data-testid="page-header" />,
}));
vi.mock('@/components/broadcast/compose-form', () => ({
  ComposeForm: () => <div data-testid="compose-form" />,
}));
vi.mock('@/components/broadcast/compose/template-picker', () => ({
  ComposeTemplatePicker: () => null,
}));

import ComposeBroadcastPage from '@/app/(member)/portal/broadcasts/new/page';

function renderPage() {
  return ComposeBroadcastPage({ searchParams: Promise.resolve({}) });
}

describe('/portal/broadcasts/new — membership-access + quota redirect (059-membership-suspension)', () => {
  beforeEach(() => {
    redirect.mockClear();
    findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
  });
  afterEach(() => vi.clearAllMocks());

  it('redirects to /portal/benefits?tab=broadcasts when suspended', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/portal/benefits?tab=broadcasts');
    expect(redirect).toHaveBeenCalledWith('/portal/benefits?tab=broadcasts');
    // The quota read must not even run once membership access is blocked.
    expect(computeQuotaCounter).not.toHaveBeenCalled();
  });

  it('redirects to /portal/benefits?tab=broadcasts when terminated', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'terminated', reason: 'grace_expired' });
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/portal/benefits?tab=broadcasts');
    expect(redirect).toHaveBeenCalledWith('/portal/benefits?tab=broadcasts');
  });

  it('still redirects on FR-009 cap===0 when membership access is full (pre-existing behaviour, now fixed to actually fire)', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
    computeQuotaCounter.mockResolvedValue({
      ok: true,
      value: { counter: { used: 0, reserved: 0, remaining: 0, cap: 0 }, quotaYear: 2026 },
    });
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/portal/benefits?tab=broadcasts');
    expect(redirect).toHaveBeenCalledWith('/portal/benefits?tab=broadcasts');
  });

  it('does NOT redirect when full and quota cap > 0 — renders the compose form', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
    computeQuotaCounter.mockResolvedValue({
      ok: true,
      value: { counter: { used: 1, reserved: 0, remaining: 9, cap: 10 }, quotaYear: 2026 },
    });
    const result = await renderPage();
    expect(redirect).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
