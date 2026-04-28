/**
 * Unit tests for <PaySheetSkeleton>. Contract:
 *   specs/009-online-payment/ux-phase3-contract.md § 2.2 rules 2, 6, 7.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { PaySheetSkeleton } from '@/components/payments/pay-sheet-skeleton';

const messages = {
  portal: {
    payment: {
      skeleton: {
        loading: 'Loading secure payment form',
      },
    },
  },
};

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PaySheetSkeleton />
    </NextIntlClientProvider>,
  );
}

describe('<PaySheetSkeleton>', () => {
  it('root has role="status", aria-busy="true", aria-live="polite"', () => {
    const { container } = renderWithIntl();
    const root = container.querySelector(
      '[data-testid="pay-sheet-card-skeleton"]',
    );
    expect(root).not.toBeNull();
    expect(root?.getAttribute('role')).toBe('status');
    expect(root?.getAttribute('aria-busy')).toBe('true');
    expect(root?.getAttribute('aria-live')).toBe('polite');
  });

  it('exposes the mandated data-testid for E2E T046', () => {
    const { container } = renderWithIntl();
    expect(
      container.querySelector('[data-testid="pay-sheet-card-skeleton"]'),
    ).not.toBeNull();
  });

  it('uses the translated aria-label from portal.payment.skeleton.loading', () => {
    const { container } = renderWithIntl();
    const root = container.querySelector(
      '[data-testid="pay-sheet-card-skeleton"]',
    );
    expect(root?.getAttribute('aria-label')).toBe(
      'Loading secure payment form',
    );
  });

  it('renders exactly 4 <Skeleton> children (3 rows + 1 button) matching PaymentElement layout', () => {
    const { container } = renderWithIntl();
    const root = container.querySelector(
      '[data-testid="pay-sheet-card-skeleton"]',
    );
    const skeletons = root?.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons?.length).toBe(4);
  });

  it('relies on the shared <Skeleton> primitive (.skeleton-shimmer class) — does not add redundant motion utilities', () => {
    const { container } = renderWithIntl();
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    // Contract § 2.2 rule 1: motion-reduce fallback is handled inside the
    // primitive via the .skeleton-shimmer CSS class. A wrapper layering
    // `motion-reduce:animate-pulse` would be a spec violation.
    skeletons.forEach((el) => {
      expect(el.className).toMatch(/skeleton-shimmer/);
      expect(el.className).not.toMatch(/motion-reduce:/);
    });
  });
});
