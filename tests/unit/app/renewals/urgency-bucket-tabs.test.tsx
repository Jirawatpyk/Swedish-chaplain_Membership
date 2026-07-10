import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { UrgencyBucketTabs } from '@/app/(staff)/admin/renewals/_components/urgency-bucket-tabs';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams(''),
}));

const COUNTS = { 't-90': 1, 't-60': 2, 't-30': 3, 't-14': 4, 't-7': 5, 't-0': 6, grace: 7, lapsed: 0 };

function renderTabs(current: 't-30' | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UrgencyBucketTabs current={current} counts={COUNTS} lapsedCount={9} />
    </NextIntlClientProvider>,
  );
}

describe('UrgencyBucketTabs colour + All state', () => {
  it('tints the t-0 count badge with the red pill band class', () => {
    renderTabs('t-30');
    // The t-0 badge (count 6) carries a red-family class from VARIANT_CLASSES.
    const badge = screen.getByText('6');
    expect(badge.className).toMatch(/red/);
  });

  it('renders with no active tab when current is null (month lens active)', () => {
    const { container } = renderTabs(null);
    expect(container.querySelector('[data-state="active"]')).toBeNull();
  });
});
