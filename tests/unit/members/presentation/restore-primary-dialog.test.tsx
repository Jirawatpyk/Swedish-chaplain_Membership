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
// The nested add-contact dialog is a form with its own fetch; stub it to what
// this dialog needs from it — the trigger it renders, the `description` it
// is handed, and the `onSaved` callback it fires after a successful add.
vi.mock('@/components/members/contact-form-dialog', () => ({
  ContactFormDialog: (props: {
    trigger: React.ReactElement;
    description?: string;
    onSaved?: () => void;
    disabled?: boolean;
  }) => (
    <div
      data-testid="cfd-stub"
      data-description={props.description ?? ''}
      data-disabled={props.disabled ? 'true' : 'false'}
    >
      {props.trigger}
      <button type="button" data-testid="cfd-saved" onClick={() => props.onSaved?.()}>
        saved
      </button>
    </div>
  ),
}));

const ANN = { contactId: 'c-ann', firstName: 'Ann', lastName: 'Alpha', email: 'ann@alpha.example' };
const BO = { contactId: 'c-bo', firstName: 'Bo', lastName: 'Beta', email: 'bo@beta.example' };
const D = enMessages.admin.members.undelete.designate;

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

  // ── T041 UX review round 1 ─────────────────────────────────────────────────

  it("shows each contact's email — the choice IS which address receives the receipts (M5)", () => {
    renderDialog();
    expect(screen.getByText(ANN.email)).toBeInTheDocument();
    expect(screen.getByText(BO.email)).toBeInTheDocument();
  });

  it('a lost race is announced INSIDE the dialog as role="alert", not as a toast the modal hides (H1)', () => {
    renderDialog({ notice: 'contact_gone' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(D.retry);
    // and it lives inside the dialog, where aria-hidden does not reach it
    expect(screen.getByRole('alertdialog')).toContainElement(alert);
  });

  it('a lost race that left NO contacts says so — "choose another" would name nobody (H1)', () => {
    renderDialog({ designatable: [], notice: 'contact_gone_none' });
    expect(screen.getByRole('alert')).toHaveTextContent(D.retryNone);
  });

  it('no notice → no alert region at all', () => {
    renderDialog();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Escape does not close the dialog while the restore is in flight (M4)', () => {
    const { onOpenChange } = renderDialog({ submitting: true });
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('zero contacts: hands the add dialog a primary-specific description and relays its onSaved (H2, M6)', () => {
    const onContactAdded = vi.fn();
    renderDialog({ designatable: [], onContactAdded });
    expect(screen.getByTestId('cfd-stub')).toHaveAttribute(
      'data-description',
      D.addContactDescription,
    );
    fireEvent.click(screen.getByTestId('cfd-saved'));
    expect(onContactAdded).toHaveBeenCalledTimes(1);
  });

  it('caps its height and scrolls — long TH copy plus five radios must not push the footer off a 320x568 screen (H3)', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.className).toContain('max-h-[85vh]');
    expect(dialog.className).toContain('overflow-y-auto');
  });

  it('the radiogroup is named by its visible legend, once (L9b)', () => {
    renderDialog();
    const group = screen.getByRole('radiogroup');
    const labelledBy = group.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent(D.contactsLabel);
    expect(group).not.toHaveAttribute('aria-label');
  });

  // ── T041 UX review round 2 ─────────────────────────────────────────────────

  it('zero contacts + restore in flight: the add door reads "Restoring…", is aria-disabled (never `disabled`), and the nested form is told not to open (N2)', () => {
    renderDialog({ designatable: [], submitting: true });
    const door = screen.getByTestId('restore-primary-add-contact');
    // `disabled` would make the nested dialog's return-focus target
    // untabbable and drop focus on <body>; aria-disabled keeps it focusable.
    expect(door).not.toHaveAttribute('disabled');
    expect(door).toHaveAttribute('aria-disabled', 'true');
    expect(door).toHaveTextContent(D.restoring);
    expect(screen.getByTestId('cfd-stub')).toHaveAttribute('data-disabled', 'true');
  });

  it('spinners respect reduced motion (motion-safe:animate-spin) (N3)', () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RestorePrimaryDialog
          open
          onOpenChange={() => {}}
          memberId="member-1"
          designatable={[ANN, BO]}
          onConfirm={() => {}}
          submitting
        />
      </NextIntlClientProvider>,
    );
    void container;
    const spinner = document.querySelector('svg.motion-safe\\:animate-spin');
    expect(spinner).not.toBeNull();
    expect(document.querySelector('svg.animate-spin:not(.motion-safe\\:animate-spin)')).toBeNull();
  });

  it('the contact list scrolls inside the dialog so the footer stays reachable at 320x568 (N5)', () => {
    renderDialog();
    const group = screen.getByRole('radiogroup');
    expect(group.className).toContain('overflow-y-auto');
    expect(group.className).toContain('max-h-[40vh]');
  });

  it('a radio is named by its label alone — no redundant aria-label (N6b)', () => {
    renderDialog();
    const radio = screen.getByRole('radio', { name: /Ann Alpha/ });
    expect(radio).not.toHaveAttribute('aria-label');
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
