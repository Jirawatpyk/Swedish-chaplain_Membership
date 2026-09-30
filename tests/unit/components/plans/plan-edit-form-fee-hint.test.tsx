// tests/unit/components/plans/plan-edit-form-fee-hint.test.tsx
//
// Plan fees are stored and invoiced EXCLUDING VAT; the fee input says so, with
// the tenant's rate when it is known.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PlanEditForm } from '@/components/plans/plan-edit-form';
import type { PlanSchemaInput } from '@/modules/plans';

afterEach(cleanup);

const PLAN: PlanSchemaInput = {
  plan_id: 'diamond',
  plan_year: 2026,
  plan_name: { en: 'Diamond' },
  description: { en: 'Top tier' },
  sort_order: 10,
  plan_category: 'corporate',
  member_type_scope: 'company',
  annual_fee_minor_units: 3_600_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: null,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: {
    eblast_per_year: 0,
    website_page_type: null,
    homepage_logo_category: null,
    directory_listing_size: null,
    event_discount_scope: 'none',
    events_cobranded_access: false,
    cultural_tickets_per_year: 0,
    m2m_benefits_access: false,
    business_referrals: false,
    tailor_made_services: false,
    partnership: null,
  },
};

function renderForm(vatRatePercent: number | null) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlanEditForm
        initialValues={PLAN}
        currentYear={2026}
        currencyUnit="THB"
        vatRatePercent={vatRatePercent}
        onSubmit={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

describe('PlanEditForm annual fee hint', () => {
  it('says the fee is whole baht excluding the tenant VAT rate', () => {
    renderForm(7);
    expect(screen.getByText('Whole baht, excluding 7% VAT.')).toBeInTheDocument();
  });

  it('still says it excludes VAT when the rate is unknown', () => {
    renderForm(null);
    expect(screen.getByText('Whole baht, excluding VAT.')).toBeInTheDocument();
  });
});

// 122 US6 (T606) — board `Admin-plan-edit` (+ `-locked`): three fieldset
// cards, Cancel / "Save changes" in an action bar, and a prior-year plan's
// locked fields read-only or disabled with the lock icon and the note.
describe('PlanEditForm on AURA', () => {
  function renderEdit(plan: PlanSchemaInput) {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PlanEditForm
          initialValues={plan}
          currentYear={2026}
          currencyUnit="THB"
          vatRatePercent={7}
          currentYearStatus="has_plan"
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      </NextIntlClientProvider>,
    );
  }
  const L = en.admin.plans.create.labels;

  it('shows the plan name, annual fee and benefit matrix as three AURA cards', () => {
    renderEdit(PLAN);
    for (const name of [L.planName, L.annualFee, L.benefitMatrix]) {
      const group = screen.getByRole('group', { name });
      expect(group).toHaveClass('aura-card');
    }
  });

  it('ends with Cancel then "Save changes" in an AURA action bar', () => {
    renderEdit(PLAN);
    const bar = screen.getByRole('region', { name: 'Actions' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Save changes']);
    expect(within(bar).getByRole('button', { name: 'Save changes' })).toHaveAttribute('type', 'submit');
  });

  it('leaves validation to the app, not the browser (the AURA fields pass `required` to the input)', () => {
    renderEdit(PLAN);
    const bar = screen.getByRole('region', { name: 'Actions' });
    expect(bar.closest('form')).toHaveAttribute('novalidate');
  });

  it('locks the prior-year fields as decided, keeping name, description and sort order editable', () => {
    renderEdit({ ...PLAN, plan_year: 2025 });
    const locked = en.admin.plans.priorYearLock.lockedField;
    const fee = screen.getByRole('textbox', { name: /^Annual fee/ });
    expect(fee).toHaveAttribute('readonly');
    expect(fee).toHaveAccessibleDescription(new RegExp(locked));
    const memberType = screen.getByRole('combobox', { name: L.memberTypeScope });
    expect(memberType).toBeDisabled();
    expect(memberType).toHaveAccessibleDescription(locked);
    expect(screen.getByRole('spinbutton', { name: L.sortOrder })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: /^Plan name \(English\)/ })).not.toHaveAttribute('readonly');
    expect(screen.getByRole('switch', { name: en.admin.plans.create.matrix.m2mBenefitsAccess })).toBeDisabled();
  });
});
