/**
 * /admin/plans/[year]/[planId]/edit — the prior-year banner's CTA depends on
 * whether the SAME plan ID exists in the current year. The page looks it up
 * and hands the answer to the banner; a soft-deleted current-year row does
 * not count (its edit page would only show a deleted plan).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { makePlan } from './plan-fixture';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));
vi.mock('@/lib/rbac', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/rbac')>()),
  requirePagePermission: vi.fn().mockResolvedValue({
    user: { id: 'staff-1', email: 'a@example.com', role: 'admin' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham' }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-1' }));

const getPlan = vi.hoisted(() => vi.fn());
vi.mock('@/modules/plans', async (importActual) => ({
  ...(await importActual<typeof import('@/modules/plans')>()),
  getPlan,
}));
const findOne = vi.hoisted(() => vi.fn());
const findByTenantAndYear = vi.hoisted(() => vi.fn());
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: () => ({
    tenant: { slug: 'swecham' },
    planRepo: { findOne, findByTenantAndYear },
    audit: {},
    taxPolicy: async () => ({ currencyCode: 'THB', vatRateRaw: '0.0700' }),
    clock: { currentYear: () => 2026 },
  }),
}));

import EditPlanPage from '@/app/(staff)/admin/plans/[year]/[planId]/edit/page';

async function renderPage() {
  const ui = await EditPlanPage({
    params: Promise.resolve({ year: '2025', planId: 'diamond' }),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('Edit plan page — prior-year banner CTA', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('looks up the current-year version and links to it when it exists', async () => {
    getPlan.mockResolvedValue({ ok: true, value: makePlan({ plan_year: 2025 }) });
    findOne.mockResolvedValue(makePlan({ plan_year: 2026 }));
    await renderPage();
    expect(findOne).toHaveBeenCalledWith({ slug: 'swecham' }, 'diamond', 2026);
    expect(screen.getByRole('link', { name: 'Open the 2026 version' })).toHaveAttribute(
      'href',
      '/admin/plans/2026/diamond/edit',
    );
  });

  it('falls back to the clone page when the current-year version is deleted and 2026 is empty', async () => {
    getPlan.mockResolvedValue({ ok: true, value: makePlan({ plan_year: 2025 }) });
    findOne.mockResolvedValue(makePlan({ plan_year: 2026, deleted_at: new Date() }));
    findByTenantAndYear.mockResolvedValue([]);
    await renderPage();
    expect(findByTenantAndYear).toHaveBeenCalledWith({ slug: 'swecham' }, { year: 2026 });
    expect(screen.queryByRole('link', { name: 'Open the 2026 version' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /2026/ })).toHaveAttribute(
      'href',
      '/admin/plans/clone?from=2025&to=2026',
    );
  });

  it('links to the new-plan wizard when 2026 has other plans but not this one', async () => {
    getPlan.mockResolvedValue({ ok: true, value: makePlan({ plan_year: 2025 }) });
    findOne.mockResolvedValue(undefined);
    findByTenantAndYear.mockResolvedValue([makePlan({ plan_id: 'gold', plan_year: 2026 })]);
    await renderPage();
    expect(screen.getByRole('link', { name: 'Create the 2026 plan' })).toHaveAttribute(
      'href',
      '/admin/plans/new',
    );
  });
});
