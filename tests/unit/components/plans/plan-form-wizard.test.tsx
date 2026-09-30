// tests/unit/components/plans/plan-form-wizard.test.tsx
//
// PlanFormWizard review step + per-field errors.
//   - Review shows the localised category / member type, not the raw enum
//     values, and the fee in the app's money format ("36,000.00 THB").
//   - Next validates the current step against `planSchema` (including the
//     cross-field rules: min < max turnover, a partnership plan bundles a
//     corporate plan). A failing step stays put and puts the message on the
//     offending field.
//   - 122 US6 (T605): on AURA as the `Admin-plan-new` board draws it — AURA's
//     Stepper (progress only: it has no error state, handoff #112), one card
//     per step, the AURA error summary for more than one error, and Cancel |
//     Back / Next with Back and Next in an action bar.

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
        currencyUnit="THB"
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
/** The open step's card title (the error summary has an h2 of its own). */
const heading = () => document.querySelector('.aura-card h2')?.textContent;
/** The step the AURA stepper marks as current. */
const currentStep = () =>
  screen.getByRole('navigation', { name: en.admin.plans.create.steps.wizardAriaLabel }).querySelector('[aria-current="step"]')
    ?.textContent;

describe('PlanFormWizard review step', () => {
  it('shows localised category + member type and the fee as "36,000.00 THB"', () => {
    renderWizard(VALID);
    next();
    next();
    next();
    expect(heading()).toBe('Review');
    const review = screen.getByRole('heading', { name: 'Review' }).closest('.aura-card') as HTMLElement;
    const r = within(review);
    expect(r.getByText('Corporate')).toBeInTheDocument();
    expect(r.getByText('Company')).toBeInTheDocument();
    expect(r.getByText('36,000.00 THB')).toBeInTheDocument();
    expect(r.queryByText('corporate')).not.toBeInTheDocument();
    expect(r.queryByText('company')).not.toBeInTheDocument();
  });
});

describe('PlanFormWizard per-field errors', () => {
  it('keeps an invalid Basics step, lists its errors in the AURA summary and flags the fields', () => {
    renderWizard();
    next();
    expect(heading()).toBe('Basics');
    expect(currentStep()).toContain('Basics');
    const planId = document.getElementById('plan_id') as HTMLInputElement;
    expect(planId).toHaveAttribute('aria-invalid', 'true');
    expect(planId).toHaveAccessibleDescription(E.planId);
    const summary = document.querySelector('.aura-error-summary') as HTMLElement;
    expect(summary).toHaveAttribute('role', 'alert');
    const links = within(summary).getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '#plan_id');
    const lines = links.map((l) => l.textContent);
    expect(lines).toEqual(
      expect.arrayContaining([
        `${en.admin.plans.create.labels.planId} — ${E.planId}`,
        `${en.admin.plans.create.labels.planName} — ${E.planName}`,
        `${en.admin.plans.create.labels.description} — ${E.description}`,
      ]),
    );
    expect(links[0]?.querySelector('strong')).toHaveTextContent(en.admin.plans.create.labels.planId);
  });

  it('puts each step in an AURA card under the stepper, with Cancel, Back and Next', () => {
    renderWizard(VALID);
    expect(screen.getByRole('heading', { level: 2, name: 'Basics' }).closest('.aura-card')).not.toBeNull();
    next();
    expect(currentStep()).toContain('Fees');
    const bar = screen.getByRole('region', { name: 'Actions' });
    const back = within(bar).getByRole('button', { name: 'Back' });
    expect(back).toHaveClass('aura-btn--secondary');
    expect(within(bar).getByRole('button', { name: 'Next' })).toHaveClass('aura-btn--primary');
    fireEvent.click(back);
    expect(heading()).toBe('Basics');
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
    expect(currentStep()).toContain('Fees');
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
    expect(document.querySelector('.aura-error-summary')).toBeNull();
    expect(currentStep()).toContain('Basics');
  });

  it('moves focus to the first invalid field when Next fails', () => {
    renderWizard();
    next();
    expect(document.activeElement).toBe(document.getElementById('plan_id'));
  });

  it('links money and locale-text errors to their inputs', () => {
    renderWizard({
      ...VALID,
      plan_name: { en: '' },
    });
    next();
    // 122 US6 (T604): the field per language is labelled as the boards write it.
    const name = screen.getByRole('textbox', { name: /^Plan name \(English\)/ });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(E.planName);
  });

  // UX review (US6): the English field can sit behind the TH / SV tab when
  // Next fails again or a summary link is followed; it comes back into view
  // and takes focus rather than focusing a hidden panel.
  it('brings the English name back into view when Next fails again from another language tab', () => {
    renderWizard({ ...VALID, plan_name: { en: '' } });
    next();
    fireEvent.click(screen.getAllByRole('tab', { name: /^TH/ })[0]!);
    next();
    const name = screen.getByRole('textbox', { name: /^Plan name \(English\)/ });
    expect(name).toBeVisible();
    expect(document.activeElement).toBe(name);
  });

  it('brings the English name back into view from its summary link', () => {
    renderWizard({ ...VALID, plan_id: 'Bad Id', plan_name: { en: '' } });
    next();
    fireEvent.click(screen.getAllByRole('tab', { name: /^SV/ })[0]!);
    const summary = document.querySelector('.aura-error-summary') as HTMLElement;
    const link = within(summary)
      .getAllByRole('link')
      .find((l) => l.textContent?.startsWith(en.admin.plans.create.labels.planName)) as HTMLElement;
    fireEvent.click(link);
    const name = screen.getByRole('textbox', { name: /^Plan name \(English\)/ });
    expect(document.activeElement).toBe(name);
  });

  it('describes max turnover with the cross-field message', () => {
    renderWizard({
      ...VALID,
      min_turnover_minor_units: 500_000_000,
      max_turnover_minor_units: 100_000_000,
    });
    next();
    next();
    const max = screen.getByRole('textbox', { name: /Maximum turnover/ });
    expect(max).toHaveAttribute('aria-invalid', 'true');
    expect(max).toHaveAccessibleDescription(E.turnoverOrder);
    expect(document.activeElement).toBe(max);
  });
});
