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

/** The four counters (the live region); the legend repeats "Used" outside it. */
const counters = () => screen.getByTestId('quota-display').querySelector('[aria-live]') as HTMLElement;

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
      const labelEl = within(counters()).getByText(label, { selector: 'span' });
      expect(labelEl.nextElementSibling).toHaveTextContent(value);
    }
    // UX review #2: two per row below 360px, where a label broke mid-word.
    expect(counters()).toHaveClass(
      'grid-cols-4',
      'max-[359px]:grid-cols-2',
    );
    // AURA Progress: the value is what is used; the reserved part rides in the
    // value text (one bar with the Dashboard's, the user's ask of 25 Oct).
    const bar = screen.getByRole('progressbar', { name: q.progressLabel });
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuetext', '2 used, 1 reserved, 3 remaining of 6');
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

  it('live={false} renders the given snapshot and never fetches (preview harness)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderQuota({ live: false });
    expect(screen.getByTestId('quota-display')).toHaveAttribute('aria-busy', 'false');
    expect(within(counters()).getByText(q.used, { selector: 'span' }).nextElementSibling).toHaveTextContent('2');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is AURA Progress with the reserved part striped, the legend and the footnote (board)', () => {
    renderQuota({ live: false });
    const card = screen.getByTestId('quota-display');
    const progress = card.querySelector('.aura-progress') as HTMLElement;
    expect(progress).toHaveClass('aura-progress--accent');
    expect(progress.querySelector('.aura-progress__bar--reserved')).not.toBeNull();
    expect(card.querySelector('[data-segment]')).toBeNull();
    // The counters already state the numbers, so the legend is not read twice.
    // AURA's own key since 5.64.0 (#179); the app stand-in is gone.
    const legend = card.querySelector('.aura-progress__legend');
    expect(screen.queryByTestId('quota-legend')).toBeNull();
    expect(legend).toHaveAttribute('aria-hidden', 'true');
    expect(legend).toHaveTextContent(q.reservedLegend);
    expect(screen.getByText(q.footnote)).toBeInTheDocument();
  });

  it('shows the legend only while something is reserved', () => {
    renderQuota({ live: false, initial: { ...SNAP, reserved: 0, remaining: 4 } });
    expect(screen.getByTestId('quota-display').querySelector('.aura-progress__legend')).toBeNull();
    expect(screen.getByTestId('quota-display').querySelector('.aura-progress__bar--reserved')).toBeNull();
  });

  it('turns the bar and the legend to danger once the quota is used up', () => {
    renderQuota({ live: false, initial: { ...SNAP, used: 5, reserved: 1, remaining: 0 } });
    const card = screen.getByTestId('quota-display');
    expect(card.querySelector('.aura-progress')).toHaveClass('aura-progress--danger');
    // The key's swatches take the bar's tone (AURA #179).
    expect(card.querySelector('.aura-progress--danger .aura-progress__swatch--reserved')).not.toBeNull();
  });

  it('says what is still reserved when no E-Blast is left (the user, 25 Oct)', () => {
    renderQuota({ live: false, initial: { ...SNAP, used: 4, reserved: 2, remaining: 0 } });
    expect(
      screen.getByText('No E-Blasts left for 2026. 2 are still reserved and are given back if they are not sent.'),
    ).toBeInTheDocument();
  });

  it('keeps "all used" when nothing is reserved', () => {
    renderQuota({ live: false, initial: { ...SNAP, used: 6, reserved: 0, remaining: 0 } });
    expect(screen.getByText('All E-Blast quota for 2026 has been used.')).toBeInTheDocument();
  });
});
