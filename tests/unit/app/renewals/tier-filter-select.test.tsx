/**
 * `<TierFilterSelect>` on AURA (spec 122 US7a, T703; board `Admin-renewals`):
 * a labelled "Tier" select. Choosing a tier replaces the URL's `tier`, and
 * drops the cursor, the month lens and the paging anchor, without a scroll
 * to the top; "All tiers" removes `tier` (FR-015, unchanged).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { TierFilterSelect } from '@/app/(staff)/admin/renewals/_components/tier-filter-select';
import en from '@/i18n/messages/en.json';

/**
 * AURA Select keeps a real <select> under its listbox: pick by changing it
 * (US5a precedent). There are two selects (the phone one is `sm:hidden`, the
 * desktop one `hidden sm:block`); jsdom shows both, so drive the desktop one.
 */
function pickNative(label: string, value: string) {
  const native = screen.getAllByRole('combobox', { name: label }).at(-1)?.closest('.aura-select')?.querySelector('select');
  if (!native) throw new Error(`no native select for ${label}`);
  fireEvent.change(native, { target: { value } });
}

const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams('urgency=t-30&month=2027-02&cursor=abc&nowIso=x'),
}));

function renderSelect(current: 'premium' | 'all' = 'all') {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TierFilterSelect current={current} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  replace.mockClear();
});

describe('<TierFilterSelect> on AURA', () => {
  it('is an AURA select named "Tier", showing the current tier', () => {
    renderSelect('premium');
    for (const select of screen.getAllByRole('combobox', { name: 'Tier' })) {
      expect(select.closest('.aura-field, .aura-select')).not.toBeNull();
      expect(select).toHaveTextContent('Premium');
    }
  });

  it('shows the word "Tier" only on a phone (board Admin-renewals-mobile); on a desktop the name is for screen readers only (maintainer, 1 Oct)', () => {
    const { container } = renderSelect();
    const [phone, desktop] = screen.getAllByRole('combobox', { name: 'Tier' });
    expect(phone?.closest('.sm\\:hidden')).not.toBeNull();
    expect(desktop?.closest('.hidden.sm\\:block')).not.toBeNull();
    // One visible "Tier" label, inside the phone variant only.
    const labels = [...container.querySelectorAll('label')].filter((l) => l.textContent?.trim() === 'Tier');
    expect(labels).toHaveLength(1);
    expect(labels[0]?.closest('.sm\\:hidden')).not.toBeNull();
    expect(desktop).toHaveAttribute('aria-label', 'Tier');
  });

  it('choosing a tier replaces the URL, dropping cursor, month and anchor, without scrolling', async () => {
    renderSelect();
    pickNative('Tier', 'premium');
    await vi.waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/admin/renewals?urgency=t-30&tier=premium', {
        scroll: false,
      }),
    );
  });

  it('"All tiers" removes the tier filter', async () => {
    renderSelect('premium');
    pickNative('Tier', 'all');
    await vi.waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/admin/renewals?urgency=t-30', { scroll: false }),
    );
  });
});
