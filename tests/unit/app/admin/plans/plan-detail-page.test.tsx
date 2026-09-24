/**
 * /admin/plans/[year]/[planId] — the detail page shows every stored benefit
 * (additional benefits, the partnership booleans, video frequency), the
 * VAT-inclusive fee, how many members are on the plan (linking to the members
 * list filtered by it), and — for `plans.write` holders — Edit + the actions
 * menu that used to exist only on the list row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { makePlan } from './plan-fixture';

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/i18n/messages/en.json')).default;
  return {
    getTranslations: vi.fn(async (namespace?: string) =>
      createTranslator({ locale: 'en', messages, ...(namespace ? { namespace } : {}) }),
    ),
  };
});
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
const role = vi.hoisted(() => ({ current: 'admin' }));
vi.mock('@/lib/rbac', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/rbac')>()),
  requirePagePermission: vi.fn(async () => ({
    user: { id: 'staff-1', email: 'a@example.com', role: role.current },
  })),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham' }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-1',
  REQUEST_ID_HEADER: 'x-request-id',
}));

const getPlan = vi.hoisted(() => vi.fn());
vi.mock('@/modules/plans', async (importActual) => ({
  ...(await importActual<typeof import('@/modules/plans')>()),
  getPlan,
}));
const countActivePlanMembers = vi.hoisted(() => vi.fn().mockResolvedValue(12));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: () => ({
    tenant: { slug: 'swecham' },
    planRepo: { findOne: vi.fn().mockResolvedValue(undefined) },
    audit: {},
    members: { countActivePlanMembers },
    taxPolicy: async () => ({ currencyCode: 'THB', vatRateRaw: '0.0700' }),
    clock: { currentYear: () => 2026 },
  }),
}));

import PlanDetailPage from '@/app/(staff)/admin/plans/[year]/[planId]/page';

async function renderPage(plan = makePlan({ plan_category: 'partnership' })) {
  getPlan.mockResolvedValue({ ok: true, value: plan });
  const ui = await PlanDetailPage({
    params: Promise.resolve({ year: String(plan.plan_year), planId: plan.plan_id }),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

/** The <dd> paired with a <dt> label. */
function valueOf(label: string): string | null | undefined {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
}

const M = en.admin.plans.create.matrix;

describe('Plan detail page', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    role.current = 'admin';
  });

  it('shows the additional benefits', async () => {
    await renderPage();
    expect(screen.getByText(M.section.additionalBenefits)).toBeInTheDocument();
    expect(valueOf(M.m2mBenefitsAccess)).toBe('Yes');
    expect(valueOf(M.businessReferrals)).toBe('No');
    expect(valueOf(M.tailorMadeServices)).toBe('Yes');
  });

  it('shows the partnership booleans and video frequency', async () => {
    await renderPage();
    expect(valueOf(M.boothIncluded)).toBe('Yes');
    expect(valueOf(M.rollupLogoAtEvents)).toBe('Yes');
    expect(valueOf(M.logoOnMerch)).toBe('No');
    expect(valueOf(M.newsletterPromotion)).toBe('Yes');
    expect(valueOf(M.eNewsletterLogo)).toBe('No');
    expect(valueOf(M.videoFrequencyScope)).toBe('Three selected events');
    expect(valueOf(M.videoDurationShort)).toBe('1.5 min');
  });

  it('shows the fee with the VAT-inclusive total', async () => {
    await renderPage();
    expect(
      screen.getByText('36,000.00 THB + 7% VAT = 38,520.00 THB'),
    ).toBeInTheDocument();
  });

  it('counts the members on the plan and links to the filtered members list', async () => {
    await renderPage();
    expect(countActivePlanMembers).toHaveBeenCalledWith({ slug: 'swecham' }, 'diamond', 2026);
    const link = screen.getByRole('link', { name: /12 members/ });
    expect(link).toHaveAttribute('href', '/admin/members?plan_id=diamond');
  });

  it('gives plans.write holders Edit and the actions menu', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      '/admin/plans/2026/diamond/edit',
    );
    expect(screen.getByRole('button', { name: 'Actions for Diamond' })).toBeInTheDocument();
  });

  it('hides Edit on a deleted plan but keeps the menu (Restore)', async () => {
    await renderPage(makePlan({ deleted_at: new Date('2026-03-01T00:00:00Z'), is_active: false }));
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Diamond' })).toBeInTheDocument();
  });

  it('shows a read-only header to a manager (plans.read only)', async () => {
    role.current = 'manager';
    await renderPage();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Diamond' })).not.toBeInTheDocument();
    // manager holds members.read, so the member count still links through
    expect(screen.getByRole('link', { name: /12 members/ })).toBeInTheDocument();
  });

  it('does not show a Partnership section for a corporate plan', async () => {
    await renderPage(makePlan());
    expect(screen.queryByText(M.section.partnershipBenefits)).not.toBeInTheDocument();
    expect(screen.getByText(M.section.additionalBenefits)).toBeInTheDocument();
  });
});
