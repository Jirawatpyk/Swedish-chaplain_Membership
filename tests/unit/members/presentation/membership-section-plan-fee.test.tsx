/**
 * WP2 — the plan picker surfaces the annual fee; spec 122 US5b-2: on AURA
 * `Select` (one line per option) the selected plan's fee is the field hint.
 *
 * Rendered against the REAL en.json (same convention as
 * membership-section-billing-cycle.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  {
    plan_id: 'premium',
    plan_year: 2026,
    display_name: 'Premium — 2026',
    annual_fee_minor_units: 5_000_000, // 50,000.00 THB
    currency_code: 'THB',
    plan_category: 'corporate',
  },
];

const EDIT_BASE: Partial<MemberFormValues> = {
  company_name: 'ACME',
  country: 'TH',
  plan_id: 'premium',
  plan_year: 2026,
  billing_cycle: 'rolling',
  primary_contact: {
    first_name: 'A',
    last_name: 'B',
    email: 'a@b.com',
    preferred_language: 'en',
  },
};

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberForm
        plans={PLANS}
        defaultPlanYear={2026}
        onSubmit={vi.fn()}
        submitting={false}
        mode="edit"
        initialValues={EDIT_BASE}
      />
    </NextIntlClientProvider>,
  );
}

describe('MembershipSection — annual-fee display (WP2; 122 US5b-2)', () => {
  it('the field shows the plan NAME only, as the board draws it', () => {
    renderForm();
    expect(screen.getByRole('combobox', { name: /^plan/i })).toHaveTextContent('Premium — 2026');
    expect(screen.getByRole('combobox', { name: /^plan/i })).not.toHaveTextContent(/50,000\.00/);
  });

  it('shows the selected plan\'s annual fee as the field hint (AURA Select lists one line per option)', () => {
    const { container } = renderForm();
    expect(container.querySelector('#plan_id-hint')).toHaveTextContent('Annual fee: 50,000.00 THB');
    expect(screen.getByRole('combobox', { name: /^plan/i })).toHaveAccessibleDescription('Annual fee: 50,000.00 THB');
  });
});
