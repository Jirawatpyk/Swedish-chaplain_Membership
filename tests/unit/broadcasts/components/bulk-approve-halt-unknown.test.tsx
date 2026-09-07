/**
 * Review 2026-09-07 round 2 (UX M-1) — when the halt state could not be
 * read, the queue page warned "Refresh before approving anything" and then
 * rendered a fully working bulk "Approve selected" directly beneath it. The
 * warning did not travel to the decision point. The confirm dialog now
 * carries `haltUnknown` and repeats the warning before Confirm.
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';
import { BulkApproveConfirmDialog } from '@/components/broadcast/admin/bulk-approve-confirm-dialog';

type Messages = Record<string, unknown>;
function pick(messages: Messages, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Messages | undefined)?.[k], messages);
}

function renderDialog(haltUnknown: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={en as never}>
      <BulkApproveConfirmDialog
        open
        onOpenChange={vi.fn()}
        broadcastCount={2}
        selectedCount={2}
        cap={50}
        totalRecipients={120}
        onConfirm={vi.fn()}
        haltUnknown={haltUnknown}
      />
    </NextIntlClientProvider>,
  );
}

describe('<BulkApproveConfirmDialog haltUnknown>', () => {
  it('admin.broadcasts.queue.bulk.confirm.haltUnknownWarning exists in en / th / sv', () => {
    for (const [locale, messages] of [['en', en], ['th', th], ['sv', sv]] as const) {
      const value = pick(messages as Messages, 'admin.broadcasts.queue.bulk.confirm.haltUnknownWarning');
      expect(typeof value, locale).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('repeats the halt warning inside the dialog when the halt state is unknown', () => {
    renderDialog(true);
    expect(screen.getByRole('alertdialog').textContent).toMatch(/halt state could not be read/i);
  });

  it('shows no such warning when the halt state was read', () => {
    renderDialog(false);
    expect(screen.getByRole('alertdialog').textContent).not.toMatch(/halt state/i);
  });
});
