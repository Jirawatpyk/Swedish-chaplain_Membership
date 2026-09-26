/**
 * CloneYearClient — read-only list of the plans the clone will copy (name,
 * annual fee, "(inactive)" where relevant). Seeded by the server for the
 * default Source year and refetched when the Source year changes, like the
 * count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { CloneYearClient } from '@/app/(staff)/admin/plans/clone/clone-year-client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SEED = [
  { plan_id: 'diamond', plan_name: { en: 'Diamond' }, annual_fee_minor_units: 3_600_000, is_active: true },
  { plan_id: 'start-up', plan_name: { en: 'Start-up' }, annual_fee_minor_units: 1_200_000, is_active: false },
];

function renderClient() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CloneYearClient
        defaultSourceYear={2026}
        defaultTargetYear={2027}
        currencyCode="THB"
        defaultSourcePlans={SEED}
      />
    </NextIntlClientProvider>,
  );
}

function preview() {
  return within(screen.getByRole('list', { name: /Plans to copy/ }));
}

describe('CloneYearClient plan preview', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('lists the seeded plans with fee and an inactive marker', () => {
    renderClient();
    const items = preview().getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Diamond');
    expect(items[0]).toContain('36,000.00 THB');
    expect(items[0]).not.toContain('inactive');
    expect(items[1]).toContain('Start-up');
    expect(items[1]).toContain('12,000.00 THB');
    expect(items[1]).toContain('(inactive)');
  });

  it('refetches the list when the Source year changes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            plan_id: 'gold',
            plan_name: { en: 'Gold' },
            annual_fee_minor_units: 2_400_000,
            is_active: true,
          },
        ],
        meta: { currency_code: 'THB' },
      }),
    });
    renderClient();
    act(() => {
      fireEvent.change(document.getElementById('source_year')!, {
        target: { value: '2025' },
      });
    });
    expect(screen.getByText(en.admin.plans.clone.preview.loading)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/plans?year=2025', expect.anything());
    const items = preview().getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([expect.stringContaining('Gold')]);
    expect(items[0]).toContain('24,000.00 THB');
  });

  it('says when the source year has no plans', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], meta: { currency_code: 'THB' } }),
    });
    renderClient();
    act(() => {
      fireEvent.change(document.getElementById('source_year')!, {
        target: { value: '2024' },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByText('No plans in 2024.')).toBeInTheDocument();
  });

  it('says when the list could not be loaded', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    renderClient();
    act(() => {
      fireEvent.change(document.getElementById('source_year')!, {
        target: { value: '2024' },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByText(en.admin.plans.clone.preview.failed)).toBeInTheDocument();
  });

  it('drops the year from the heading while a partial year is typed', () => {
    renderClient();
    act(() => {
      fireEvent.change(document.getElementById('source_year')!, {
        target: { value: '202' },
      });
    });
    expect(screen.queryByText('Plans to copy from 202')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plans to copy' })).toBeInTheDocument();
  });
});
