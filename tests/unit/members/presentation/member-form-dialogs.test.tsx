/**
 * 122 US5b-2 (T578) — the member form's dialogs on AURA `Dialog`: the
 * plan-change confirmation as its board (`Admin-member-plan-change`: Cancel
 * first and focused, "What this does and does not change" as a heading), and
 * the bundle-warning, override-reason and soft-duplicate dialogs (no board:
 * AURA defaults, content and behaviour unchanged).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import enMessages from '@/i18n/messages/en.json';
import { PlanChangeConfirmDialog } from '@/components/members/plan-change-confirm-dialog';
import { BundleChangeWarningDialog } from '@/components/members/bundle-change-warning-dialog';
import { OverrideReasonDialog } from '@/components/members/override-reason-dialog';
import { SoftDuplicateDialog } from '@/components/members/soft-duplicate-dialog';

const M = enMessages.admin.members;

function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlanChangeConfirmDialog on AURA (board Admin-member-plan-change)', () => {
  const summary = {
    oldPlanId: 'large',
    oldPlanYear: 2026,
    newPlanId: 'premium',
    newPlanYear: 2026,
    oldPlanLabel: 'Large Corporate — 2026',
    newPlanLabel: 'Premium Corporate — 2026',
    oldFeeMinorUnits: 2_600_000,
    newFeeMinorUnits: 3_600_000,
    currencyCode: 'THB',
    yearOnly: false,
  };

  it('is an AURA dialog whose "what changes" note is a heading, with Cancel first and focused', async () => {
    const onOpenChange = vi.fn();
    wrap(<PlanChangeConfirmDialog open onOpenChange={onOpenChange} summary={summary} onConfirm={vi.fn()} submitting={false} />);
    const dialog = screen.getByRole('alertdialog', { name: M.planChangeConfirm.title });
    expect(dialog).toHaveClass('aura-dialog');
    expect(within(dialog).getByRole('heading', { level: 3, name: M.planChangeConfirm.billingNoteHeading })).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole('button').filter((b) => b.textContent);
    expect(buttons.map((b) => b.textContent)).toEqual([M.planChangeConfirm.cancel, M.planChangeConfirm.confirm]);
    await waitFor(() => expect(document.activeElement).toBe(buttons[0]));
    fireEvent.click(buttons[0]!);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('BundleChangeWarningDialog on AURA', () => {
  it('is an AURA dialog named by its title that confirms once the count has loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 3 }) }));
    const onConfirm = vi.fn();
    wrap(
      <BundleChangeWarningDialog
        open
        onOpenChange={vi.fn()}
        payload={{ oldBundleCorporatePlanId: 'a', newBundleCorporatePlanId: 'b', oldPlanId: 'p', oldPlanYear: 2026 }}
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: M.bundleChangeWarning.title });
    expect(dialog).toHaveClass('aura-dialog');
    await waitFor(() => expect(within(dialog).getByText('3 members affected')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole('button', { name: M.bundleChangeWarning.confirm }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('OverrideReasonDialog on AURA', () => {
  it('asks for a reason on an AURA Select and requires a note for "Other"', async () => {
    const onConfirm = vi.fn();
    const { container } = wrap(
      <OverrideReasonDialog open onOpenChange={vi.fn()} warningMessage="Turnover is outside the band." onConfirm={onConfirm} />,
    );
    const dialog = screen.getByRole('dialog', { name: M.overrideReason.title });
    expect(dialog).toHaveClass('aura-dialog');
    expect(within(dialog).getByText('Turnover is outside the band.').closest('.aura-alert')).not.toBeNull();
    const proceed = within(dialog).getByRole('button', { name: M.overrideReason.proceed });
    expect(proceed).toBeDisabled();

    const select = container.ownerDocument.getElementById('override_code-select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    fireEvent.change(select, { target: { value: 'other' } });
    // UX review: the note's "required" error waits until the note has been
    // left empty (never on picking "Other" before typing anything).
    const noteField = within(dialog).getByLabelText(new RegExp(M.overrideReason.noteLabel));
    expect(within(dialog).queryByText(M.overrideReason.noteRequired)).toBeNull();
    fireEvent.blur(noteField);
    await waitFor(() => expect(within(dialog).getByText(M.overrideReason.noteRequired)).toBeInTheDocument());
    expect(proceed).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(new RegExp(M.overrideReason.noteLabel)), { target: { value: 'Board minutes 12' } });
    expect(proceed).not.toBeDisabled();
    fireEvent.click(proceed);
    expect(onConfirm).toHaveBeenCalledWith({ code: 'other', note: 'Board minutes 12' });
  });
});

describe('SoftDuplicateDialog on AURA', () => {
  it('names the existing member, opens it in a new tab, and proceeds on request', () => {
    const onProceed = vi.fn();
    wrap(
      <SoftDuplicateDialog
        open
        onOpenChange={vi.fn()}
        existing={{ member_id: 'm-1', company_name: 'Nordic Timber' }}
        onProceed={onProceed}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: M.softDuplicate.title });
    expect(dialog).toHaveClass('aura-dialog');
    expect(within(dialog).getByText('Nordic Timber')).toBeInTheDocument();
    const link = within(dialog).getByRole('link', { name: new RegExp(M.softDuplicate.openExisting) });
    expect(link).toHaveAttribute('href', '/admin/members/m-1');
    expect(link).toHaveAttribute('target', '_blank');
    // UX review: focus starts on Cancel (the safe action), never on the link
    // that opens a new tab.
    expect(within(dialog).getByRole('button', { name: M.softDuplicate.cancel })).toHaveAttribute('data-autofocus');
    fireEvent.click(within(dialog).getByRole('button', { name: M.softDuplicate.proceed }));
    expect(onProceed).toHaveBeenCalledTimes(1);
  });
});
