/**
 * The payment-timeline Suspense fallback is a named, busy loading region.
 * `aria-label` is only permitted on an element with a role, so without
 * `role="status"` axe flags `aria-prohibited-attr` whenever a scan lands
 * while the skeleton is showing (R13, invoice-admin-a11y on mobile-chrome).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/messages/en.json';
import { PaymentTimelineSkeleton } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline-skeleton';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => {
    const value: unknown = (en.admin.paymentReconciliation.timeline as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : key;
  }),
}));

describe('PaymentTimelineSkeleton', () => {
  it('is a busy status region named by its loading label', async () => {
    render(await PaymentTimelineSkeleton());
    const region = screen.getByRole('status', { name: 'Loading payment activity' });
    expect(region).toHaveAttribute('aria-busy', 'true');
  });

  it('draws an AURA card with AURA skeleton blocks (spec 122 US8b T826)', async () => {
    const { container } = render(await PaymentTimelineSkeleton());
    expect(container.querySelector('.aura-card')).not.toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton-block"]').length).toBeGreaterThan(0);
  });
});
