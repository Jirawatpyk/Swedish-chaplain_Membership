/**
 * WP5 — the downgrade confirmation dialog body.
 *
 * Force-opened via `<AlertDialog open onOpenChange={()=>{}}>` (a full
 * click-to-open flow deadlocks Base UI's portal focus in jsdom). Rendered
 * against the REAL en.json. Verifies the before/after price rows, the numeric
 * quota deltas (rendered only when both from + to are known), and the
 * over-quota warning (shown only when usage already exceeds the new plan).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { AlertDialog } from '@/components/ui/alert-dialog';
import {
  DowngradeConfirmDialogBody,
  type DowngradeConfirmDialogBodyProps,
} from '@/app/(member)/portal/renewal/[memberId]/_components/downgrade-confirm-dialog-body';

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

function renderDialog(overrides?: Partial<DowngradeConfirmDialogBodyProps>) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AlertDialog open onOpenChange={() => {}}>
        <DowngradeConfirmDialogBody
          currentLabel="Premium"
          newLabel="Regular"
          currentPriceMinorUnits={9_000_000} // ฿90,000.00
          newPriceMinorUnits={5_000_000} // ฿50,000.00
          submitting={false}
          onConfirm={() => {}}
          onCancel={() => {}}
          {...overrides}
        />
      </AlertDialog>
    </NextIntlClientProvider>,
  );
}

describe('DowngradeConfirmDialogBody (WP5)', () => {
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
});
