// tests/unit/components/plans/plan-form-wizard.test.tsx
//
// PlanFormWizard review step + per-field errors.
//   - Review shows the localised category / member type, not the raw enum
//     values, and the fee in the app's money format ("36,000.00 THB").
//   - Next validates the current step against `planSchema` (including the
//     cross-field rules: min < max turnover, a partnership plan bundles a
//     corporate plan). A failing step stays put, marks its Stepper circle as
//     an error and puts the message on the offending field.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PlanFormWizard } from '@/components/plans/plan-form-wizard';
import type { PlanSchemaInput } from '@/modules/plans';

afterEach(cleanup);

const E = en.admin.plans.create.fieldErrors;

const VALID: PlanSchemaInput = {
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

const PARTNERSHIP = {
  event_tickets_included: 2,
  booth_included: false,
  rollup_logo_at_events: false,
  logo_on_merch: false,
  video_duration_minutes: 1,
  video_frequency_scope: 'all_events',
  website_logo_months: 12,
  banner_per_year: 0,
  newsletter_promotion: false,
  enewsletter_logo: false,
  directory_ad_position: 'first_pages',
} as const;

function renderWizard(initialValues?: PlanSchemaInput) {
  const onSubmit = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlanFormWizard
        currentYear={2026}
        currencyPrefix="฿"
        currencyCode="THB"
        vatRatePercent={7}
        {...(initialValues ? { initialValues } : {})}
        onSubmit={onSubmit}
      />
    </NextIntlClientProvider>,
  );
  return { onSubmit };
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));
const heading = () => screen.getByRole('heading', { level: 2 }).textContent;
const stepStatus = (index: number) =>
  document.querySelectorAll('[data-slot="stepper-step"]')[index]?.getAttribute('data-status');

describe('PlanFormWizard review step', () => {
  it('shows localised category + member type and the fee as "36,000.00 THB"', () => {
    renderWizard(VALID);
    next();
    next();
    next();
    expect(heading()).toBe('Review');
    const review = screen.getByRole('heading', { name: 'Review' }).closest('section')!;
    const r = within(review);
    expect(r.getByText('Corporate')).toBeInTheDocument();
    expect(r.getByText('Company')).toBeInTheDocument();
    expect(r.getByText('36,000.00 THB')).toBeInTheDocument();
    expect(r.queryByText('corporate')).not.toBeInTheDocument();
    expect(r.queryByText('company')).not.toBeInTheDocument();
  });
});

describe('PlanFormWizard per-field errors', () => {
  it('keeps an invalid Basics step, marks it as an error and flags the fields', () => {
    renderWizard();
    next();
    expect(heading()).toBe('Basics');
    expect(stepStatus(0)).toBe('error');
    const planId = document.getElementById('plan_id') as HTMLInputElement;
    expect(planId).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(E.planId)).toBeInTheDocument();
    expect(screen.getByText(E.planName)).toBeInTheDocument();
    expect(screen.getByText(E.description)).toBeInTheDocument();
  });

  it('clears a field message once the value is fixed', () => {
    renderWizard({ ...VALID, plan_id: 'Bad Id' });
    next();
    expect(screen.getByText(E.planId)).toBeInTheDocument();
    fireEvent.change(document.getElementById('plan_id')!, { target: { value: 'gold' } });
    expect(screen.queryByText(E.planId)).not.toBeInTheDocument();
    next();
    expect(heading()).toBe('Fees');
  });

  it('flags max turnover when it is not above min turnover (cross-field rule)', () => {
    renderWizard({
      ...VALID,
      min_turnover_minor_units: 500_000_000,
      max_turnover_minor_units: 100_000_000,
    });
    next();
    expect(heading()).toBe('Fees');
    next();
    expect(heading()).toBe('Fees');
    expect(stepStatus(1)).toBe('error');
    expect(screen.getByText(E.turnoverOrder)).toBeInTheDocument();
  });

  it('flags a partnership plan with no bundled corporate plan (cross-field rule)', () => {
    renderWizard({
      ...VALID,
      plan_category: 'partnership',
      benefit_matrix: { ...VALID.benefit_matrix, partnership: PARTNERSHIP },
    });
    next();
    next();
    expect(heading()).toBe('Fees');
    expect(screen.getByText(E.bundleRequired)).toBeInTheDocument();
    expect(document.getElementById('bundle')).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not show messages before the step is attempted', () => {
    renderWizard();
    expect(screen.queryByText(E.planId)).not.toBeInTheDocument();
    expect(stepStatus(0)).toBe('current');
  });
});
