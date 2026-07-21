/**
 * WP7 — `PlanChangeConfirmDialog` render (BP3, ux-standards § 6.2).
 *
 * Rendered against the REAL en.json. Base UI AlertDialog renders its content
 * when `open`; the Confirm button carries a plain onClick (no transition), so
 * a fireEvent click is safe under jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PlanChangeConfirmDialog } from '@/components/members/plan-change-confirm-dialog';
import type { PlanChangeSummary } from '@/components/members/plan-change-summary';

const SUMMARY: PlanChangeSummary = {
  oldPlanId: 'premium',
  oldPlanYear: 2026,
  newPlanId: 'regular',
  newPlanYear: 2026,
  oldPlanLabel: 'Premium — 2026',
  newPlanLabel: 'Regular — 2026',
  oldFeeMinorUnits: 5_000_000,
  newFeeMinorUnits: 3_000_000,
  currencyCode: 'THB',
  yearOnly: false,
};

const C = enMessages.admin.members.planChangeConfirm;

function renderDialog(
  props: Partial<React.ComponentProps<typeof PlanChangeConfirmDialog>> = {},
) {
  const onConfirm = props.onConfirm ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PlanChangeConfirmDialog
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        onConfirm={onConfirm}
        submitting={false}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { onConfirm };
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanChangeConfirmDialog', () => {
  it('shows both plan labels and their formatted fees', () => {
    renderDialog();
    expect(screen.getByText('Premium — 2026')).toBeInTheDocument();
    expect(screen.getByText('Regular — 2026')).toBeInTheDocument();
    expect(screen.getByText(/50,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/30,000\.00/)).toBeInTheDocument();
  });

  it('shows "Not available" when a fee is unknown', () => {
    renderDialog({ summary: { ...SUMMARY, oldFeeMinorUnits: null } });
    expect(screen.getByText(new RegExp(C.feeUnknown))).toBeInTheDocument();
  });

  it('hides the year-only notice when yearOnly is false', () => {
    renderDialog();
    expect(screen.queryByText(C.yearOnlyNotice)).toBeNull();
  });

  it('shows the year-only notice when yearOnly is true', () => {
    renderDialog({ summary: { ...SUMMARY, yearOnly: true } });
    expect(screen.getByText(C.yearOnlyNotice)).toBeInTheDocument();
  });

  it('shows the automatic future-cycles billing note (flag is true post-remediation)', () => {
    renderDialog();
    expect(
      screen.getByText(C.billingNoteFutureCyclesAutomatic),
    ).toBeInTheDocument();
    expect(screen.queryByText(C.billingNoteFutureCycles)).toBeNull();
  });

  it('calls onConfirm exactly once when Confirm is clicked', () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: C.confirm }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables both footer buttons while submitting', () => {
    renderDialog({ submitting: true });
    expect(screen.getByRole('button', { name: C.confirm })).toBeDisabled();
    expect(screen.getByRole('button', { name: C.cancel })).toBeDisabled();
  });
});
