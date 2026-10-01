/**
 * `<RenewalsByMonthSection>` on AURA (spec 122 US7a, T705; board
 * `Admin-renewals`): an AURA `Card` titled "Renewals by month" with the open
 * count, holding the focus target the month chip returns focus to; a load
 * failure is an AURA danger alert in the same card.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { RenewalsByMonthSection } from '@/app/(staff)/admin/renewals/_components/renewals-by-month-section';

const NOW = '2026-09-30T05:00:00.000Z';

async function renderSection(summaryPromise: Parameters<typeof RenewalsByMonthSection>[0]['summaryPromise']) {
  const el = await RenewalsByMonthSection({
    tenantSlug: 'tenant-a',
    nowIso: NOW,
    selectedMonth: null,
    summaryPromise,
  });
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {el}
    </NextIntlClientProvider>,
  );
}

describe('<RenewalsByMonthSection> on AURA', () => {
  it('is an AURA card titled "Renewals by month" with the open count, around the focus target', async () => {
    await renderSection(
      Promise.resolve({
        ok: true as const,
        v: {
          ok: true as const,
          value: {
            buckets: [
              { key: 'overdue', count: 4 },
              { key: '2026-10', count: 9 },
            ],
            maxCount: 9,
            totalCount: 13,
          },
        },
      }) as never,
    );
    const heading = screen.getByRole('heading', { name: 'Renewals by month' });
    expect(heading.closest('.aura-card')).not.toBeNull();
    expect(screen.getByText('13 open renewals')).toBeInTheDocument();
    expect(document.getElementById('renewals-by-month')).toHaveAttribute('tabindex', '-1');
  });

  it('a load failure is an AURA danger alert inside the card', async () => {
    await renderSection(Promise.resolve({ ok: false as const, e: new Error('boom') }) as never);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(en.admin.renewals.byMonth.loadFailed);
    expect(alert.closest('.aura-card')).not.toBeNull();
  });
});
