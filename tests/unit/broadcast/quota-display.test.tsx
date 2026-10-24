/**
 * Spec 122 US12d-1 (T1235) — the E-Blast quota card on AURA (board
 * `Portal-broadcasts`): an AURA card whose head carries the year on the left
 * and the plan · renewal on the right; four counters, each a label above its
 * number; the progressbar, live region, testids, retry and skeleton kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { QuotaDisplay, type QuotaSnapshot } from '@/components/broadcast/quota-display';

const q = en.portal.broadcasts.quota;

const SNAP: QuotaSnapshot = {
  used: 2,
  reserved: 1,
  remaining: 3,
  cap: 6,
  quotaYear: 2026,
  planName: 'Premium Corporate',
};

function renderQuota(props: Partial<React.ComponentProps<typeof QuotaDisplay>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <QuotaDisplay initial={SNAP} nextResetCopy="Renews 1 January 2027" {...props} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('QuotaDisplay on AURA', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...SNAP }) }),
    );
  });

  it('is an AURA card; its head has the year, then the plan and the renewal date', async () => {
    renderQuota();
    const card = screen.getByTestId('quota-display');
    expect(card).toHaveClass('aura-card');
    const title = screen.getByText(q.headerLabel.replace('{year}', '2026'));
    const head = title.parentElement!;
    expect(within(head).getByText(/Premium Corporate/)).toBeInTheDocument();
    expect(within(head).getByTestId('quota-next-reset')).toHaveTextContent('Renews 1 January 2027');
    await waitFor(() => expect(card).toHaveAttribute('aria-busy', 'false'));
  });

  it('shows each counter as a label above its number', () => {
    renderQuota();
    for (const [label, value] of [
      [q.used, '2'],
      [q.reserved, '1'],
      [q.remaining, '3'],
      [q.cap, '6'],
    ] as const) {
      const labelEl = screen.getByText(label, { selector: 'span' });
      expect(labelEl.nextElementSibling).toHaveTextContent(value);
    }
    expect(screen.getByRole('progressbar', { name: q.progressLabel })).toHaveAttribute(
      'aria-valuenow',
      '3',
    );
  });

  it('a failed load offers an AURA Retry button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    renderQuota({ initial: null });
    const retry = await screen.findByRole('button', { name: q.retry });
    expect(retry).toHaveClass('aura-btn');
    expect(screen.getByText(q.fetchError)).toBeInTheDocument();
  });

  it('reserves the loaded shape with the shared skeleton blocks', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderQuota({ initial: null });
    const card = screen.getByTestId('quota-display');
    expect(card.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThanOrEqual(6);
    expect(card.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
