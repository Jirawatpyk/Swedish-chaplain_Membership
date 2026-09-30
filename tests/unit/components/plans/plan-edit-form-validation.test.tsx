// tests/unit/components/plans/plan-edit-form-validation.test.tsx
//
// The edit form validates the diffed patch with `planPatchSchema` before it
// hands the draft to `onSubmit`, and shows one message per invalid field
// (same keys as the create wizard) instead of relying on the server's 422.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PlanEditForm } from '@/components/plans/plan-edit-form';
import type { PlanSchemaInput } from '@/modules/plans';

afterEach(cleanup);

const E = en.admin.plans.create.fieldErrors;

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

function renderForm() {
  const onSubmit = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlanEditForm
        initialValues={PLAN}
        currentYear={2026}
        currencyPrefix="฿"
        onSubmit={onSubmit}
      />
    </NextIntlClientProvider>,
  );
  return { onSubmit };
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const sortOrder = () => document.getElementById('sort_order') as HTMLInputElement;
const englishName = () =>
  screen.getByRole('textbox', { name: 'Plan name (EN)' }) as HTMLInputElement;

describe('PlanEditForm save-time validation', () => {
  it('blocks an out-of-range sort order and flags the field', () => {
    const { onSubmit } = renderForm();
    fireEvent.change(sortOrder(), { target: { value: '20000' } });
    save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(E.sortOrder)).toBeInTheDocument();
    expect(sortOrder()).toHaveAttribute('aria-invalid', 'true');
    expect(sortOrder()).toHaveAttribute('aria-describedby', 'sort_order-error');
    expect(document.activeElement).toBe(sortOrder());
  });

  it('blocks an empty English name', () => {
    const { onSubmit } = renderForm();
    fireEvent.change(englishName(), { target: { value: '' } });
    save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(E.planName)).toBeInTheDocument();
    expect(englishName()).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows no message before a save attempt, and clears it once fixed', () => {
    renderForm();
    fireEvent.change(sortOrder(), { target: { value: '20000' } });
    expect(screen.queryByText(E.sortOrder)).not.toBeInTheDocument();
    save();
    expect(screen.getByText(E.sortOrder)).toBeInTheDocument();
    fireEvent.change(sortOrder(), { target: { value: '20' } });
    expect(screen.queryByText(E.sortOrder)).not.toBeInTheDocument();
    expect(sortOrder()).not.toHaveAttribute('aria-invalid');
  });

  it('submits a valid edit with the draft unchanged', () => {
    const { onSubmit } = renderForm();
    fireEvent.change(sortOrder(), { target: { value: '20' } });
    save();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ ...PLAN, sort_order: 20 });
  });
});
