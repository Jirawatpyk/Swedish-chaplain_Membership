/**
 * `/admin/directory` — the staff directory pages through every member.
 *
 * The page asked `searchDirectory` for 50 rows and rendered no pager, so on a
 * 131-member tenant members 51+ could only be reached by searching. It now
 * renders the shared `<TablePagination>` under the table (visible count +
 * page links that keep `q` / `listed`) and clamps a past-the-end `?page` to
 * the last page instead of showing an empty table.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const currentSearch = vi.hoisted(() => ({ value: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  usePathname: () => '/admin/directory',
  useSearchParams: () => currentSearch.value,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => {
    const t = (key: string, params?: Record<string, unknown>): string =>
      params ? `${key}:${JSON.stringify(params)}` : key;
    return t;
  }),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/rbac', () => ({
  requirePagePermission: vi.fn().mockResolvedValue({
    user: { id: 'staff-1', email: 'staff@example.com', role: 'admin' },
  }),
}));
vi.mock('@/lib/env', () => ({
  env: { features: { f9Dashboard: true }, tenant: { timezone: 'Asia/Bangkok' } },
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/components/directory/generate-export-actions', () => ({
  GenerateExportActions: () => null,
}));
vi.mock('@/components/directory/recent-exports', () => ({
  RecentExports: () => null,
}));

const searchDirectory = vi.hoisted(() => vi.fn());
vi.mock('@/modules/insights', () => ({
  searchDirectory,
  makeSearchDirectoryDeps: () => ({}),
  listDirectoryExports: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  makeGenerateDirectoryExportDeps: () => ({}),
}));

import DirectoryPage from '@/app/(staff)/admin/directory/page';

const TOTAL = 131;

// Page links are looked up by their `aria-label` ("Page N"): the shared pager's
// Base UI button primitive gives its <a> elements role="button".

function rows(page: number, pageSize: number) {
  const from = (page - 1) * pageSize;
  const count = Math.max(0, Math.min(pageSize, TOTAL - from));
  return Array.from({ length: count }, (_, i) => ({
    memberId: `m-${from + i + 1}`,
    companyName: `Company ${from + i + 1}`,
    status: 'active',
    tier: null,
    listed: true,
    fieldVisibility: {},
    industry: null,
    locationCity: null,
    locationCountry: null,
    hasLogo: false,
    contactName: null,
  }));
}

searchDirectory.mockImplementation(
  async (input: { page: number; pageSize: number }) => ({
    ok: true,
    value: {
      items: rows(input.page, input.pageSize),
      total: TOTAL,
      page: input.page,
      pageSize: input.pageSize,
    },
  }),
);

async function renderPage(query: Record<string, string>) {
  currentSearch.value = new URLSearchParams(query);
  const ui = await DirectoryPage({ searchParams: Promise.resolve(query) });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('DirectoryPage — pagination', () => {
  afterEach(() => searchDirectory.mockClear());

  it('renders a pager with a visible count when total > pageSize', async () => {
    await renderPage({});
    expect(screen.getByText('Showing 1–50 of 131')).toBeInTheDocument();
    expect(screen.getByLabelText('Page 2')).toHaveAttribute(
      'href',
      '/admin/directory?page=2',
    );
    expect(screen.getByLabelText('Page 3')).toBeInTheDocument();
  });

  it('page 2 requests page 2 with the same filters, and the pager keeps q + listed', async () => {
    await renderPage({ q: 'nordic', listed: 'true', page: '2' });
    expect(searchDirectory).toHaveBeenCalledTimes(1);
    expect(searchDirectory.mock.calls[0]![0]).toEqual({
      q: 'nordic',
      listedOnly: true,
      page: 2,
      pageSize: 50,
    });
    expect(screen.getByText('Showing 51–100 of 131')).toBeInTheDocument();
    expect(screen.getByLabelText('Page 3')).toHaveAttribute(
      'href',
      '/admin/directory?q=nordic&listed=true&page=3',
    );
    expect(screen.getByLabelText('Page 1')).toHaveAttribute(
      'href',
      '/admin/directory?q=nordic&listed=true',
    );
  });

  it('clamps a past-the-end page to the last page instead of an empty table', async () => {
    await renderPage({ q: 'nordic', page: '9' });
    expect(searchDirectory.mock.calls.map((c) => (c[0] as { page: number }).page)).toEqual([
      9, 3,
    ]);
    expect(searchDirectory.mock.calls[1]![0]).toMatchObject({ q: 'nordic' });
    expect(screen.getByText('Showing 101–131 of 131')).toBeInTheDocument();
    expect(screen.getByText('Company 131')).toBeInTheDocument();
  });
});
