/**
 * /admin/plans/clone — reads `?from=` / `?to=` (the prior-year banner links
 * here with both) to prefill Source year and Target year. Only whole years in
 * 2000–2100 are accepted; anything else falls back to the defaults (current
 * year → next year). The source-year preview is loaded for the prefilled
 * source year, not always for the current year.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/rbac', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/rbac')>()),
  requirePagePermission: vi.fn().mockResolvedValue({
    user: { id: 'staff-1', email: 'a@example.com', role: 'admin' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham' }),
}));

const listPlans = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    value: { data: [], meta: { currency_code: 'THB' } },
  }),
);
vi.mock('@/modules/plans', async (importActual) => ({
  ...(await importActual<typeof import('@/modules/plans')>()),
  listPlans,
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: () => ({
    tenant: { slug: 'swecham' },
    planRepo: {},
    taxPolicy: async () => ({ currencyCode: 'THB', vatRateRaw: '0.0700' }),
    clock: { currentYear: () => 2026 },
  }),
}));

import CloneYearPage from '@/app/(staff)/admin/plans/clone/page';

async function renderPage(searchParams: Record<string, string | string[] | undefined>) {
  const ui = await CloneYearPage({ searchParams: Promise.resolve(searchParams) });
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
  return {
    source: document.getElementById('source_year') as HTMLInputElement,
    target: document.getElementById('target_year') as HTMLInputElement,
  };
}

describe('Clone year page — from/to prefill', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('prefills Source and Target year from valid params and previews the source year', async () => {
    const { source, target } = await renderPage({ from: '2025', to: '2027' });
    expect(source.value).toBe('2025');
    expect(target.value).toBe('2027');
    expect(listPlans).toHaveBeenCalledWith(
      { filter: { year: 2025 } },
      expect.anything(),
    );
  });

  it('defaults to current → next year with no params', async () => {
    const { source, target } = await renderPage({});
    expect(source.value).toBe('2026');
    expect(target.value).toBe('2027');
  });

  it.each([
    ['non-numeric', { from: 'abc', to: 'xyz' }],
    ['out of range', { from: '1999', to: '2101' }],
    ['not a whole year', { from: '2025.5', to: '2027e0' }],
    ['repeated param', { from: ['2024', '2025'], to: ['2027', '2028'] }],
  ])('ignores %s values and falls back to the defaults', async (_label, params) => {
    const { source, target } = await renderPage(params);
    expect(source.value).toBe('2026');
    expect(target.value).toBe('2027');
    expect(listPlans).toHaveBeenCalledWith(
      { filter: { year: 2026 } },
      expect.anything(),
    );
  });
});
