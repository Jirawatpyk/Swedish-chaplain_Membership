// @vitest-environment jsdom
/**
 * The admin invoice detail's payment-activity Suspense fallback carried an
 * `aria-label` on a role-less Card. ARIA prohibits naming a generic element,
 * so axe flagged `aria-prohibited-attr` (serious) whenever a scan landed while
 * the skeleton was still showing (spec 122 US4 e2e checkpoint R13,
 * `invoice-admin-a11y:78`). The fallback is a status region named by its
 * localized label, and stays busy.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => `timeline.${key}`),
}));

import { PaymentTimelineSkeleton } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline-skeleton';

describe('<PaymentTimelineSkeleton>', () => {
  it('is a busy status region named by the localized loading label', async () => {
    render(await PaymentTimelineSkeleton());
    const region = screen.getByRole('status', { name: 'timeline.loading' });
    expect(region).toHaveAttribute('aria-busy', 'true');
  });
});
