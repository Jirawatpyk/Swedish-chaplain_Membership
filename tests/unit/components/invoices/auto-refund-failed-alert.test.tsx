/**
 * F5 UX D2 — AutoRefundFailedAlert component test.
 *
 * Pins the destructive banner an admin sees on the invoice detail page when an
 * automatic stale-invoice refund FAILED at the processor (money not returned —
 * manual reconciliation required). Mirrors the EmailFailureAlert test harness:
 * next-intl is mocked to echo `key {vals}` so assertions can read both the key
 * and the interpolated ref / runbook path.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations:
    () =>
    (key: string, vals?: Record<string, unknown>) =>
      vals ? `${key} ${JSON.stringify(vals)}` : key,
}));

const { AutoRefundFailedAlert } = await import(
  '@/app/(staff)/admin/invoices/_components/auto-refund-failed-alert'
);

describe('AutoRefundFailedAlert (F5 UX D2)', () => {
  it('renders a destructive alert with title, body, the FULL processor refund ref, and the runbook path', () => {
    render(
      <AutoRefundFailedAlert
        processorRefundId="re_test_ABCD1234"
        runbookUrl="docs/runbooks/out-of-band-refund.md"
      />,
    );
    // Alert carries role="alert" (destructive tone).
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('autoRefundFailed.title')).toBeDefined();
    // Staff reconcile in the Stripe Dashboard — surface the FULL refund id
    // (not the member-side last-8 truncation).
    const refLine = screen.getByTestId('admin-invoice-auto-refund-failed-ref');
    expect(refLine.textContent).toContain('re_test_ABCD1234');
    // The reconciliation runbook path is surfaced for the admin to follow.
    expect(screen.getByText(/out-of-band-refund\.md/)).toBeDefined();
  });

  it('omits the reference line when no processor refund id is available (still renders title + body)', () => {
    render(
      <AutoRefundFailedAlert
        processorRefundId={null}
        runbookUrl="docs/runbooks/out-of-band-refund.md"
      />,
    );
    expect(
      screen.queryByTestId('admin-invoice-auto-refund-failed-ref'),
    ).toBeNull();
    expect(screen.getByText('autoRefundFailed.title')).toBeDefined();
    expect(screen.getByText('autoRefundFailed.body')).toBeDefined();
  });
});
