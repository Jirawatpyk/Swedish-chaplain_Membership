/**
 * 0309 — `<BillIssuedBadge>`: the pipeline marker for a renewal bill issued
 * BEFORE T-0 against a paid period. Such a cycle is `awaiting_payment` yet
 * keeps a countdown urgency (access stays full until expiry), so without a
 * marker staff cannot tell it from an un-billed `upcoming` row.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { BillIssuedBadge } from '@/components/renewals/bill-issued-badge';
import type { CycleStatus, UrgencyBucket } from '@/modules/renewals';
import en from '@/i18n/messages/en.json';

function renderBadge(
  status: CycleStatus,
  urgency: UrgencyBucket,
  linkedInvoiceId: string | null = 'inv-1',
) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BillIssuedBadge status={status} urgency={urgency} linkedInvoiceId={linkedInvoiceId} />
    </NextIntlClientProvider>,
  );
}

describe('<BillIssuedBadge>', () => {
  it('shows "Bill issued" for an awaiting_payment cycle still in a countdown bucket', () => {
    renderBadge('awaiting_payment', 't-30');
    expect(screen.getByText('Bill issued')).toBeDefined();
    // The reason is exposed to screen readers, not only via `title`.
    expect(
      screen.getByText(/benefits continue until the current period ends/),
    ).toBeDefined();
  });

  it.each([
    ['awaiting_payment', 'suspended'], // born-awaiting / period ended — the pill already says it
    ['upcoming', 't-30'], // no bill yet
    ['reminded', 't-7'],
  ] as const)('renders nothing for %s / %s', (status, urgency) => {
    const { container } = renderBadge(status, urgency);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when no bill is linked (voided, or the issue failed)', () => {
    const { container } = renderBadge('awaiting_payment', 't-30', null);
    expect(container.textContent).toBe('');
  });
});
