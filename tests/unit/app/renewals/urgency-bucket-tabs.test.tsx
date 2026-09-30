/**
 * `<UrgencyBucketTabs>` — the stage chips T-90 … T-0, Suspended and
 * Terminated (spec 122 US7a, T703; board `Admin-renewals`).
 *
 * AURA link tabs: each chip is a link to the pipeline URL with `urgency`
 * set and the month lens, cursor and `nowIso` anchor dropped (same URL
 * contract as before, FR-015), without a scroll to the top (operator
 * report: the jump yanked the user away from the strip). With a month lens
 * active no chip is current, and each one says why the chips are paused.
 * On a phone the board draws an "Urgency" select with the same choices.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { UrgencyBucketTabs } from '@/app/(staff)/admin/renewals/_components/urgency-bucket-tabs';
import en from '@/i18n/messages/en.json';

/** AURA Select keeps a real <select> under its listbox: pick by changing it (US5a precedent). */
function pickNative(label: string, value: string) {
  const native = screen.getByRole('combobox', { name: label }).closest('.aura-select')?.querySelector('select');
  if (!native) throw new Error(`no native select for ${label}`);
  fireEvent.change(native, { target: { value } });
}

// `month=2027-02` models a stale month-lens URL: choosing a chip must drop it.
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams('month=2027-02&cursor=abc&nowIso=x'),
}));

// Records the `scroll` prop each chip link is rendered with.
vi.mock('next/link', () => ({
  default: ({
    href,
    scroll,
    children,
    ...rest
  }: {
    href: string;
    scroll?: boolean;
    children?: React.ReactNode;
  }) => (
    <a href={href} data-scroll={String(scroll)} {...rest}>
      {children}
    </a>
  ),
}));

const COUNTS = { 't-90': 1, 't-60': 2, 't-30': 3, 't-14': 4, 't-7': 5, 't-0': 6, suspended: 7, terminated: 0 };

function renderTabs(current: 't-30' | null, monthLensActive = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UrgencyBucketTabs
        current={current}
        counts={COUNTS}
        lapsedCount={9}
        monthLensActive={monthLensActive}
      />
    </NextIntlClientProvider>,
  );
}

function chips(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Filter by renewal urgency' });
}

beforeEach(() => push.mockClear());

describe('<UrgencyBucketTabs> AURA link tabs', () => {
  it('renders the eight chips in board order as AURA tabs, each with its count', () => {
    renderTabs('t-30');
    expect(chips()).toHaveClass('aura-tabs');
    const links = within(chips()).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'T-901',
      'T-602',
      'T-303',
      'T-144',
      'T-75',
      'T-06',
      'Suspended7',
      // Terminated counts the lapsed cycles.
      'Terminated9',
    ]);
  });

  it('names each chip with its label first, then the member count', () => {
    renderTabs('t-30');
    expect(within(chips()).getByRole('link', { name: 'T-30, 3 members' })).toBeInTheDocument();
    expect(within(chips()).getByRole('link', { name: 'T-90, 1 member' })).toBeInTheDocument();
  });

  it('marks exactly the current chip with aria-current', () => {
    renderTabs('t-30');
    const current = within(chips())
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('T-30');
  });

  it('links each chip to its urgency, dropping the month lens, cursor and anchor, without scrolling to the top', () => {
    renderTabs('t-30');
    const link = within(chips()).getByRole('link', { name: /^T-14/ });
    expect(link).toHaveAttribute('href', '/admin/renewals?urgency=t-14');
    expect(link).toHaveAttribute('data-scroll', 'false');
  });
});

describe('<UrgencyBucketTabs> month lens (item ③)', () => {
  it('no chip is current while a month lens is active', () => {
    renderTabs(null, true);
    for (const link of within(chips()).getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('shows a visible "Paused" badge, hidden from screen readers', () => {
    renderTabs(null, true);
    // The chips row's badge (the phone select shows the same words as its placeholder).
    const badge = within(chips().parentElement!).getByText(en.admin.renewals.urgencyBuckets.monthLensBadge);
    expect(badge.closest('[aria-hidden]')).not.toBeNull();
  });

  it('each chip is described by the paused hint, and still exits the lens', () => {
    renderTabs(null, true);
    const link = within(chips()).getByRole('link', { name: /^T-30/ });
    const hintId = link.getAttribute('aria-describedby');
    expect(document.getElementById(hintId!)?.textContent).toMatch(/month filter/i);
    expect(link).toHaveAttribute('href', '/admin/renewals?urgency=t-30');
  });

  it('no badge and no description without a month lens', () => {
    renderTabs('t-30');
    expect(screen.queryByText(en.admin.renewals.urgencyBuckets.monthLensBadge)).toBeNull();
    expect(within(chips()).getByRole('link', { name: /^T-30/ })).not.toHaveAttribute(
      'aria-describedby',
    );
  });
});

describe('<UrgencyBucketTabs> phone select (board Admin-renewals-mobile)', () => {
  it('an "Urgency" select lists each stage with its count, the current one chosen', () => {
    renderTabs('t-30');
    const select = screen.getByRole('combobox', { name: 'Urgency' });
    expect(select).toHaveTextContent('T-30 (3)');
    const native = select.closest('.aura-select')?.querySelector('select');
    expect([...(native?.options ?? [])].map((o) => o.textContent)).toContain('Terminated (9)');
  });

  it('choosing a stage navigates like its chip, without scrolling', () => {
    renderTabs('t-30');
    pickNative('Urgency', 'suspended');
    expect(push).toHaveBeenCalledWith('/admin/renewals?urgency=suspended', { scroll: false });
  });
});
