/**
 * #765 — the at-risk widget showed only its first 20 members per band (the
 * band tab counts were already the true totals). "Show more" now loads the
 * band's next 20 from the API's own `next_cursor` and appends them; it goes
 * away once there is no next page, a band change starts again from the first
 * page, the new count is announced, and focus moves to the first new row.
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * React rendering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AtRiskWidget } from '@/app/(staff)/admin/renewals/_components/at-risk-widget';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const SUMMARY = { warning: 0, 'at-risk': 22, critical: 1, f6_active: true, active_max: 100 };
const row = (n: number, band = 'at-risk') => ({
  member_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  company_name: `Member ${n}`,
  risk_score: 72,
  risk_score_band: band,
  risk_score_last_computed_at: '2026-09-01T00:00:00.000Z',
  risk_snoozed_until: null,
});
const FIRST = { items: Array.from({ length: 20 }, (_, i) => row(i + 1)), next_cursor: 'cur-2', summary: SUMMARY };
const SECOND = { items: [row(21), row(22)], next_cursor: null, summary: SUMMARY };
const CRITICAL = { items: [row(90, 'critical')], next_cursor: null, summary: SUMMARY };

const fetchMock = vi.fn(async (url: string) => {
  const u = new URL(url, 'http://x');
  const body =
    u.searchParams.get('band') === 'critical' ? CRITICAL : u.searchParams.get('cursor') === 'cur-2' ? SECOND : FIRST;
  return new Response(JSON.stringify(body), { status: 200 });
});

beforeEach(() => {
  vi.useRealTimers();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function renderWidget() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AtRiskWidget canSnooze />
    </NextIntlClientProvider>,
  );
}

const M = en.admin.renewals.atRisk.showMore;

describe('AtRiskWidget — Show more (#765)', () => {
  it('appends the next page from the cursor, announces the count, focuses the first new row, then hides', async () => {
    renderWidget();
    expect(await screen.findByText('Member 20')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: M.action }));

    expect(await screen.findByText('Member 22')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/admin/renewals/at-risk?band=at-risk&limit=20&cursor=cur-2',
    );
    expect(screen.getByText('Member 1')).toBeInTheDocument();
    expect(screen.getByTestId('at-risk-shown-status')).toHaveTextContent('Showing 22 of 22');
    await waitFor(() => expect(document.activeElement).toHaveTextContent('Member 21'));
    expect(screen.queryByRole('button', { name: M.action })).toBeNull();
  });

  it('shows no button when the band fits on one page', async () => {
    renderWidget();
    fireEvent.click(await screen.findByRole('tab', { name: /critical/i }));
    expect(await screen.findByText('Member 90')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: M.action })).toBeNull();
  });

  it('a failed load says so with a retry, and keeps the rows already shown', async () => {
    renderWidget();
    expect(await screen.findByText('Member 20')).toBeInTheDocument();
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    fireEvent.click(screen.getByRole('button', { name: M.action }));
    expect(await screen.findByText(M.failed)).toBeInTheDocument();
    expect(screen.getByText('Member 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.admin.renewals.atRisk.actions.retry }));
    expect(await screen.findByText('Member 22')).toBeInTheDocument();
  });
});
