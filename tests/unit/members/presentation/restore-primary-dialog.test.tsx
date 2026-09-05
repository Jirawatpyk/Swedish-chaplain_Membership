/**
 * 108 T039 (US2 / FR-014) — `RestorePrimaryDialog`.
 *
 * Opened by the archived banner when the undelete route answers 409
 * `no_primary_contact`. The member cannot be restored without a primary, so
 * the dialog offers the member's live contacts and restores + designates in
 * ONE action — never a restore that leaves the member with nobody to send
 * receipts to.
 *
 * Rendered against the REAL en.json. Base UI AlertDialog renders its content
 * when `open`; the confirm button carries a plain onClick, so fireEvent is
 * safe under jsdom (same harness as plan-change-confirm-dialog.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RestorePrimaryDialog } from '@/components/members/restore-primary-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const ANN = { contactId: 'c-ann', firstName: 'Ann', lastName: 'Alpha' };
const BO = { contactId: 'c-bo', firstName: 'Bo', lastName: 'Beta' };

function renderDialog(
  props: Partial<React.ComponentProps<typeof RestorePrimaryDialog>> = {},
) {
  const onConfirm = props.onConfirm ?? vi.fn();
  const onOpenChange = props.onOpenChange ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RestorePrimaryDialog
        open
        onOpenChange={onOpenChange}
        memberId="member-1"
        designatable={[ANN, BO]}
        onConfirm={onConfirm}
        submitting={false}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { onConfirm, onOpenChange };
}

beforeEach(() => {
  // The shared setup installs fake timers; `waitFor` never advances under
  // them and the test dies at the 30 s cap (sibling dialog tests reset too).
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RestorePrimaryDialog (108 FR-014)', () => {
  it('is an alert dialog with an accessible name — the choice interrupts the restore on purpose', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName();
    expect(dialog).toHaveAccessibleDescription();
  });

  it('lists every designatable contact as a radio, by name', () => {
    renderDialog();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /Ann Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Bo Beta/ })).toBeInTheDocument();
  });

  it('keeps the restore button disabled until a contact is chosen — no silent default', () => {
    const { onConfirm } = renderDialog();
    const confirm = screen.getByTestId('restore-primary-confirm');
    // Auto-selecting the first contact would be the "silently chooses who
    // receives money emails" the spec rejected (research R4/R5).
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('restores with the chosen contact id, and only that id', async () => {
    const { onConfirm } = renderDialog();
    // Base UI radios take the pick from the associated <label> click (the
    // repo's event-fee-form tests select the same way).
    fireEvent.click(screen.getByText('Bo Beta'));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Bo Beta/ })).toBeChecked(),
    );
    const confirm = screen.getByTestId('restore-primary-confirm');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('c-bo');
  });

  it('disables the whole form while the restore is in flight', () => {
    renderDialog({ submitting: true });
    expect(screen.getByTestId('restore-primary-confirm')).toBeDisabled();
    // Base UI renders a disabled radio as <span role="radio" aria-disabled>
    // (not a natively-disabled element), so assert the ARIA state — the same
    // precedent as event-fee-form.test.tsx.
    for (const r of screen.getAllByRole('radio')) {
      expect(r).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('with zero live contacts: explains, offers "add a contact", and has NO restore button', () => {
    renderDialog({ designatable: [] });
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByTestId('restore-primary-confirm')).toBeNull();
    // The remedy is reachable from here — the page hides the add-contact
    // button for archived members, so this is the only door.
    expect(screen.getByTestId('restore-primary-add-contact')).toBeInTheDocument();
  });

  it('Cancel closes without restoring', async () => {
    const { onConfirm, onOpenChange } = renderDialog();
    fireEvent.click(screen.getByText('Ann Alpha'));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Ann Alpha/ })).toBeChecked(),
    );
    fireEvent.click(screen.getByTestId('restore-primary-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
