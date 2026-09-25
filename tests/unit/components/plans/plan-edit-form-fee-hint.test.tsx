// tests/unit/components/plans/plan-edit-form-fee-hint.test.tsx
//
// Plan fees are stored and invoiced EXCLUDING VAT; the fee input says so, with
// the tenant's rate when it is known.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
        currencyPrefix="฿"
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
