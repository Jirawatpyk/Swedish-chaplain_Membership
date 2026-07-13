/**
 * Gap B/C (2026-07-12) — new admin payment-timeline i18n keys + the
 * pending-refund a11y announcer.
 *
 * The payment-timeline is an async Server Component, so its i18n keys are
 * exercised here through a tiny client probe rendered against the REAL
 * en.json (a missing key would surface as the raw key path / MISSING_MESSAGE
 * rather than the resolved copy). The RefundPendingAnnouncer is the small
 * client wrapper that gives the pending state a polite live-region
 * announcement without re-announcing the whole (Server-rendered) timeline.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RefundPendingAnnouncer } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-pending-announcer';

function KeyProbe() {
  const t = useTranslations('admin.paymentReconciliation.timeline');
  const tEvents = useTranslations(
    'admin.paymentReconciliation.timeline.events',
  );
  return (
    <div>
      <span data-testid="refund-pending-label">
        {tEvents('refund_pending')}
      </span>
      <span data-testid="auto-refunded-label">{tEvents('auto_refunded')}</span>
      <span data-testid="pending-hint">{t('refundPendingHint')}</span>
    </div>
  );
}

describe('admin payment-timeline new i18n keys (Gap B/C)', () => {
  it('resolves refund_pending / auto_refunded / refundPendingHint against real en.json', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <KeyProbe />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('refund-pending-label').textContent).toBe(
      'Refund settling — awaiting processor confirmation',
    );
    expect(screen.getByTestId('auto-refunded-label').textContent).toBe(
      'Payment auto-refunded',
    );
    expect(screen.getByTestId('pending-hint').textContent).toBe(
      'A credit note will be issued once the refund settles.',
    );
  });
});

describe('RefundPendingAnnouncer (Gap B a11y)', () => {
  it('announces the pending message in a polite live region after mount', () => {
    render(
      <RefundPendingAnnouncer message="Refund settling — awaiting processor confirmation" />,
    );
    // The message is set in an effect so the live region MUTATES after mount
    // (screen readers announce subsequent mutations, not initial content);
    // RTL's `render` flushes that effect inside `act`, so it is present now.
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region).toHaveTextContent(
      'Refund settling — awaiting processor confirmation',
    );
  });
});
