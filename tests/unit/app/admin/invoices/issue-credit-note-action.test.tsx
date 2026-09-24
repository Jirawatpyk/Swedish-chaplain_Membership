/**
 * The invoice detail page's "Issue credit note…" action. While a refund on the
 * invoice's payment is still settling, the server refuses a manual credit note
 * (`refund_in_progress`, 8A) — so the action must not be clickable then; it
 * explains why instead of leading the admin into a guaranteed refusal.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { IssueCreditNoteAction } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/issue-credit-note-action';

const actions = enMessages.admin.invoices.detail.actions;

function renderAction(refundSettling: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <IssueCreditNoteAction invoiceId="inv-1" refundSettling={refundSettling} />
    </NextIntlClientProvider>,
  );
}

describe('<IssueCreditNoteAction>', () => {
  it('links to the credit-note form when no refund is settling', () => {
    renderAction(false);
    expect(screen.getByRole('link', { name: actions.issueCreditNote })).toHaveAttribute(
      'href',
      '/admin/invoices/inv-1/credit-notes/new',
    );
  });

  it('is disabled (not a link) with an explanation while a refund is settling', () => {
    renderAction(true);
    expect(screen.queryByRole('link', { name: actions.issueCreditNote })).toBeNull();
    const button = screen.getByRole('button', { name: actions.issueCreditNote });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(actions.issueCreditNoteRefundSettling);
  });
});
