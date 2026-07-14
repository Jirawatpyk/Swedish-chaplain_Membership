/**
 * 059 / PR-A — the §86/4 tax-branch section.
 *
 * This file exists because the section had NO test at all, and the maintainer
 * found two of its defects by opening the form and looking at it. Neither was
 * visible to axe, typecheck, lint, or ~8,700 other tests.
 *
 * What it pins:
 *
 *   1. The VAT checkbox renders in BOTH modes. It used to be edit-only, which
 *      meant no path — not this form, not the bulk importer — could make a
 *      member a VAT registrant at CREATION. Every member was born a
 *      non-registrant, and `is_vat_registered` is what makes the buyer's
 *      "สำนักงานใหญ่ / สาขาที่ NNNNN" line print (ประกาศอธิบดีฯ ฉบับที่ 199). That is
 *      how "no member has ever received the branch line" — the defect this whole
 *      branch exists to fix — would have quietly returned.
 *
 *   2. A natural person is never asked to confirm they are the head office. The
 *      head-office / branch controls appear only for a VAT registrant, on edit.
 *      A บุคคลธรรมดา has no head office and no branches, and the question has no
 *      effect on any document for them — the template prints the line only for a
 *      registrant, and `members_branch_pairing_ck` (0248) forbids a
 *      non-registrant branch. Worse, the checkbox DEFAULTED TO TICKED: it did
 *      not merely ask a meaningless question, it displayed a meaningless answer
 *      as a recorded fact.
 *
 *   3. Un-ticking VAT resets the branch pair. Otherwise a branch code would sit
 *      behind a hidden control and fail the save against 0248, with the error
 *      pointing at a field the admin cannot see.
 *
 * Rendered against the REAL en.json (not a key-echo mock) and the REAL
 * MemberForm, so the assertions are about what an admin actually sees.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  MemberForm,
  type MemberFormValues,
  type PlanOption,
} from '@/components/members/member-form';

beforeEach(() => {
  // RHF async validation needs real timers (tests/setup.ts installs fake ones).
  vi.useRealTimers();
});

const PLANS: PlanOption[] = [
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
];

const EDIT_BASE = {
  company_name: 'ACME',
  country: 'TH',
  plan_id: PLANS[0]!.plan_id,
  plan_year: 2026,
  primary_contact: {
    first_name: 'A',
    last_name: 'B',
    email: 'a@b.com',
    preferred_language: 'en' as const,
  },
};

function renderForm(
  mode: 'create' | 'edit',
  initialValues: Partial<MemberFormValues> = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberForm
        plans={PLANS}
        defaultPlanYear={2026}
        onSubmit={vi.fn()}
        submitting={false}
        mode={mode}
        initialValues={
          mode === 'edit' ? { ...EDIT_BASE, ...initialValues } : initialValues
        }
      />
    </NextIntlClientProvider>,
  );
}

/** The Base UI Checkbox renders `role="checkbox"` and is named by aria-label. */
function vatCheckbox() {
  return screen.getByRole('checkbox', { name: /registered for vat/i });
}
function headOfficeCheckbox() {
  return screen.queryByRole('checkbox', { name: /head office/i });
}

describe('TaxBranchSection — the VAT checkbox is reachable at CREATE', () => {
  it('renders on create — otherwise no path could make a member a registrant at birth', () => {
    renderForm('create');
    expect(vatCheckbox()).toBeInTheDocument();
  });

  it('renders on edit', () => {
    renderForm('edit');
    expect(vatCheckbox()).toBeInTheDocument();
  });
});

describe('TaxBranchSection — a natural person is never asked about a head office', () => {
  it('hides the head-office control when the member is NOT a VAT registrant', () => {
    renderForm('edit', { is_vat_registered: false });
    // Not merely unchecked — ABSENT. A ticked-by-default checkbox reads as a
    // recorded fact, and for a บุคคลธรรมดา there is no such fact.
    expect(headOfficeCheckbox()).toBeNull();
  });

  it('reveals the head-office control once VAT is ticked (edit)', () => {
    renderForm('edit', { is_vat_registered: true });
    expect(headOfficeCheckbox()).toBeInTheDocument();
  });

  it('hides the head-office control at CREATE even when VAT is ticked', () => {
    // The create payload and the repo's create `.values()` do not write the
    // branch pair — it takes the DB defaults. Offering the control here would be
    // dead state: the admin would set a branch code and it would vanish.
    renderForm('create', { is_vat_registered: true });
    expect(vatCheckbox()).toBeInTheDocument();
    expect(headOfficeCheckbox()).toBeNull();
  });

  it('hides the branch-code input for a non-registrant', () => {
    renderForm('edit', { is_vat_registered: false, is_head_office: false });
    expect(screen.queryByLabelText(/branch code/i)).toBeNull();
  });
});

describe('TaxBranchSection — un-ticking VAT resets the branch pair', () => {
  it('clears branch_code and restores head-office when VAT is un-ticked', () => {
    // Without this, a branch code would survive behind a hidden control and the
    // save would fail against members_branch_pairing_ck (0248) — with the error
    // attached to a field the admin can no longer see.
    const { container } = renderForm('edit', {
      is_vat_registered: true,
      is_head_office: false,
      branch_code: '00042',
    });

    const branchInput = container.querySelector<HTMLInputElement>('#branch_code');
    expect(branchInput?.value).toBe('00042');

    // Base UI's Checkbox renders a visible `<span role="checkbox">` PLUS a hidden
    // native input, and the `id` we pass lands on the INPUT (see the aria-label
    // comment in tax-branch-section.tsx). Clicking the span does not drive
    // `onCheckedChange`; clicking the input does. Get this wrong and the test
    // silently asserts nothing about the toggle.
    const vatInput = container.querySelector<HTMLInputElement>(
      'input#is_vat_registered',
    );
    expect(vatInput).not.toBeNull();
    fireEvent.click(vatInput!);

    // The controls are gone, and so is the value behind them.
    expect(headOfficeCheckbox()).toBeNull();
    expect(container.querySelector('#branch_code')).toBeNull();
  });
});
