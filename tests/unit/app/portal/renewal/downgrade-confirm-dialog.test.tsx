/**
 * WP5 — the downgrade confirmation dialog, on AURA since spec 122 US7c.
 *
 * An AURA alertdialog, rendered open against the REAL en.json. Verifies the
 * before/after price rows, the numeric quota deltas (rendered only when both
 * from + to are known), the over-quota warning (shown only when usage already
 * exceeds the new plan) and that the warning rides on the dialog's accessible
 * description, so a screen reader hears it when the dialog opens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  DowngradeConfirmDialog,
  DOWNGRADE_DIALOG_OVERQUOTA_ID,
  type DowngradeConfirmDialogProps,
} from '@/app/(member)/portal/renewal/[memberId]/_components/downgrade-confirm-dialog';

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

function renderDialog(overrides?: Partial<DowngradeConfirmDialogProps>) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DowngradeConfirmDialog
        open
        currentLabel="Premium"
        newLabel="Regular"
        currentPriceMinorUnits={9_000_000} // ฿90,000.00
        newPriceMinorUnits={5_000_000} // ฿50,000.00
        submitting={false}
        onConfirm={() => {}}
        onCancel={() => {}}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
}

const dialog = () => screen.getByRole('alertdialog', { name: 'Confirm a lower-priced plan' });

describe('DowngradeConfirmDialog on AURA (US7c)', () => {
  it('is an AURA alertdialog: Cancel takes first focus, Confirm is the primary action', () => {
    renderDialog();
    const cancel = within(dialog()).getByRole('button', { name: 'Keep my current plan' });
    const confirm = within(dialog()).getByRole('button', { name: 'Yes, switch to this plan' });
    expect(document.activeElement).toBe(cancel);
    expect(confirm.className).toMatch(/aura-btn--primary/);
  });

  it('while the request runs, Confirm is busy and the dialog cannot be dismissed', () => {
    const onCancel = vi.fn();
    renderDialog({ submitting: true, onCancel });
    expect(within(dialog()).getByRole('button', { name: 'Yes, switch to this plan' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Cancel and Confirm call back', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderDialog({ onCancel, onConfirm });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Keep my current plan' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Yes, switch to this plan' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('DowngradeConfirmDialog (WP5)', () => {
  it('renders the title as a heading and the before/after price', () => {
    renderDialog();
    expect(
      screen.getByRole('heading', { name: 'Confirm a lower-priced plan' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('price-current').textContent).toContain('90,000.00');
    expect(screen.getByTestId('price-new').textContent).toContain('50,000.00');
  });

  it('renders numeric quota deltas when both from + to are known', () => {
    renderDialog({
      eblast: { from: 12, to: 4, used: 0 },
      culturalTickets: { from: 6, to: 2, used: 0 },
    });
    expect(screen.getByText(/E-Blasts per year: 12 → 4/)).toBeInTheDocument();
    expect(
      screen.getByText(/Cultural event tickets per year: 6 → 2/),
    ).toBeInTheDocument();
  });

  it('omits a quota row when the target quota is unknown (null / unlimited)', () => {
    renderDialog({ eblast: { from: 12, to: null, used: 0 } });
    expect(screen.queryByText(/E-Blasts per year/)).toBeNull();
  });

  it('shows the over-quota warning ONLY when usage exceeds the new plan quota', () => {
    const over = renderDialog({ eblast: { from: 12, to: 4, used: 6 } });
    expect(screen.getByText(/You have already used 6 of/)).toBeInTheDocument();
    over.unmount();

    renderDialog({ eblast: { from: 12, to: 4, used: 2 } });
    expect(screen.queryByText(/You have already used/)).toBeNull();
  });

  // C4 a11y (WCAG 4.1.3) — a `role="status"` region already present at open
  // does NOT re-announce, so the over-quota fact must live in the dialog's
  // accessible description. We reference the over-quota region from the
  // popup's `aria-describedby` so a screen reader hears it when the dialog
  // opens (alongside the base description).
  it('describes the dialog with the switch sentence AND the over-quota region when over quota (C4/WCAG 4.1.3)', () => {
    renderDialog({ eblast: { from: 12, to: 4, used: 6 } });
    const ids = (dialog().getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0]!)?.textContent).toBe(
      'You are switching from Premium to Regular. This lowers your renewal price and reduces some membership benefits.',
    );
    expect(ids[1]).toBe(DOWNGRADE_DIALOG_OVERQUOTA_ID);
    expect(document.getElementById(DOWNGRADE_DIALOG_OVERQUOTA_ID)!.textContent).toContain(
      'You have already used 6 of',
    );
  });

  it('describes the dialog with the switch sentence only when NOT over quota (C4)', () => {
    renderDialog({ eblast: { from: 12, to: 4, used: 2 } });
    const ids = (dialog().getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids).toHaveLength(1);
    expect(document.getElementById(DOWNGRADE_DIALOG_OVERQUOTA_ID)).toBeNull();
  });
});
