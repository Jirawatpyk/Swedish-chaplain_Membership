/**
 * 122 US6 (T604) — the plan forms' shared pieces on AURA (boards
 * `Admin-plan-new`, `Admin-plan-edit`, `Admin-plan-edit-locked`):
 * - the name / description with EN / TH / SV AURA tabs above the field, a
 *   tab whose translation is missing marked;
 * - the money field with "THB" as its suffix and the same whole-baht parse;
 * - the benefit matrix on AURA Select / Switch / TextField;
 * - a locked (prior-year) field: read-only or disabled, with the lock icon,
 *   and read to a screen reader as locked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/i18n/messages/en.json';
import { LocaleTextInput } from '@/components/plans/locale-text-input';
import { MoneyInput } from '@/components/plans/money-input';
import { BenefitMatrixEditor } from '@/components/plans/benefit-matrix-editor';
import { PlanLockedNote, PLAN_LOCKED_NOTE_ID } from '@/components/plans/plan-locked-note';
import type { BenefitMatrix } from '@/modules/plans';

const C = en.admin.plans.create;

function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {node}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('LocaleTextInput on AURA tabs', () => {
  it('puts EN / TH / SV tabs above the field, each language its own labelled field', () => {
    const onChange = vi.fn();
    wrap(<LocaleTextInput label={C.labels.planName} value={{ en: 'Premium Corporate' }} onChange={onChange} required />);
    const tablist = screen.getByRole('tablist', { name: 'Plan name language' });
    expect(within(tablist).getAllByRole('tab').map((t) => t.textContent)).toEqual(['EN', 'TH', 'SV']);
    const field = screen.getByRole('textbox', { name: /^Plan name \(English\)/ });
    expect(field).toHaveValue('Premium Corporate');
    expect(field).toBeRequired();
    fireEvent.click(within(tablist).getByRole('tab', { name: /^TH/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /^Plan name \(Thai\)/ }), { target: { value: 'พรีเมียม' } });
    expect(onChange).toHaveBeenLastCalledWith({ en: 'Premium Corporate', th: 'พรีเมียม' });
  });

  it('marks a tab whose translation is missing', () => {
    wrap(<LocaleTextInput label={C.labels.description} value={{ en: 'x', th: 'y' }} onChange={vi.fn()} multiline />);
    expect(screen.getByRole('tab', { name: 'SV (Swedish) — translation missing' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'TH' })).toBeInTheDocument();
  });

  it('shows an error on the English field, switching back to it', () => {
    const { rerender } = wrap(<LocaleTextInput label={C.labels.planName} value={{ en: '' }} onChange={vi.fn()} required />);
    fireEvent.click(screen.getByRole('tab', { name: /^SV/ }));
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <LocaleTextInput label={C.labels.planName} value={{ en: '' }} onChange={vi.fn()} required error="Enter a name" />
      </NextIntlClientProvider>,
    );
    const field = screen.getByRole('textbox', { name: /^Plan name \(English\)/ });
    expect(field).toBeVisible();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter a name');
  });
});

describe('MoneyInput on AURA', () => {
  it('is an AURA field with the currency as its suffix and the same whole-baht parse', () => {
    const onChange = vi.fn();
    wrap(<MoneyInput label={C.labels.annualFee} value={3_600_000} onChange={onChange} unit="THB" required helpText="Whole baht, excluding 7% VAT." />);
    const field = screen.getByRole('textbox', { name: /^Annual fee/ });
    expect(field.closest('.aura-field')).not.toBeNull();
    expect(field).toHaveValue('36000');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(field.closest('.aura-field')).toHaveTextContent('THB');
    expect(field).toHaveAccessibleDescription('Whole baht, excluding 7% VAT.');
    fireEvent.change(field, { target: { value: '26,000' } });
    expect(onChange).toHaveBeenLastCalledWith(2_600_000);
    onChange.mockClear();
    fireEvent.change(field, { target: { value: '200000000' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is read-only with the lock icon and read as locked when the plan is locked', () => {
    wrap(
      <>
        <PlanLockedNote />
        <MoneyInput label={C.labels.annualFee} value={3_600_000} onChange={vi.fn()} unit="THB" locked />
      </>,
    );
    const field = screen.getByRole('textbox', { name: /^Annual fee/ });
    expect(field).toHaveAttribute('readonly');
    expect(field.getAttribute('aria-describedby')).toContain(PLAN_LOCKED_NOTE_ID);
    expect(field).toHaveAccessibleDescription(en.admin.plans.priorYearLock.lockedField);
    expect(field.closest('.aura-field')?.querySelector('.has-icon, [class*="has-icon"]')).not.toBeNull();
  });
});

const MATRIX: BenefitMatrix = {
  eblast_per_year: 6,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'premium',
  directory_listing_size: 'full_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: true,
  cultural_tickets_per_year: 2,
  m2m_benefits_access: true,
  business_referrals: false,
  tailor_made_services: true,
  partnership: null,
} as BenefitMatrix;

describe('BenefitMatrixEditor on AURA', () => {
  it('uses AURA selects, switches and number fields, and patches the matrix', () => {
    const onChange = vi.fn();
    wrap(<BenefitMatrixEditor value={MATRIX} onChange={onChange} planCategory="corporate" />);
    expect(screen.getByRole('combobox', { name: C.matrix.websitePageType })).toHaveTextContent(C.options.websitePageType.member_news_update);
    expect(screen.getByRole('spinbutton', { name: C.matrix.eblastPerYear })).toHaveValue(6);
    const referrals = screen.getByRole('switch', { name: C.matrix.businessReferrals });
    expect(referrals).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(referrals);
    expect(onChange).toHaveBeenLastCalledWith({ ...MATRIX, business_referrals: true });
  });

  it('locks every benefit on a prior-year plan', () => {
    wrap(
      <>
        <PlanLockedNote />
        <BenefitMatrixEditor value={MATRIX} onChange={vi.fn()} planCategory="corporate" locked />
      </>,
    );
    expect(screen.getByRole('spinbutton', { name: C.matrix.eblastPerYear })).toHaveAttribute('readonly');
    const select = screen.getByRole('combobox', { name: C.matrix.websitePageType });
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription(en.admin.plans.priorYearLock.lockedField);
    expect(screen.getByRole('switch', { name: C.matrix.m2mBenefitsAccess })).toBeDisabled();
  });
});
