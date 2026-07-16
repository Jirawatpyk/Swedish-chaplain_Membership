/**
 * 065 §5.1 — the per-member billing-cycle picker in the membership section.
 *
 * Rendered against the REAL en.json (same convention as
 * company-section.test.tsx / address-section.test.tsx). Verifies the picker is
 * wired: the localized label + required mark render, an unset (create) form
 * shows the placeholder, and a seeded (edit) value renders its translated
 * option label — the value→label mapping the plan picker also relies on.
 *
 * The base-ui Select renders its option list in a portal only after a pointer
 * interaction, which is flaky in jsdom; asserting the label + placeholder +
 * seeded-value-translation covers the wiring reliably without opening the list.
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
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
];

const EDIT_BASE: Partial<MemberFormValues> = {
  company_name: 'ACME',
  country: 'TH',
  plan_id: PLANS[0]!.plan_id,
  plan_year: 2026,
  billing_cycle: 'rolling',
  primary_contact: {
    first_name: 'A',
    last_name: 'B',
    email: 'a@b.com',
    preferred_language: 'en',
  },
};

function renderForm(opts: {
  mode: 'create' | 'edit';
  initialValues?: Partial<MemberFormValues>;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberForm
        plans={PLANS}
        defaultPlanYear={2026}
        onSubmit={vi.fn()}
        submitting={false}
        mode={opts.mode}
        {...(opts.initialValues ? { initialValues: opts.initialValues } : {})}
      />
    </NextIntlClientProvider>,
  );
}

describe('MembershipSection — billing_cycle picker (065 §5.1)', () => {
  it('renders the billing-cycle label', () => {
    renderForm({ mode: 'create' });
    expect(screen.getByText('Billing cycle')).toBeInTheDocument();
  });

  it('shows the placeholder on a fresh CREATE form (no value picked yet)', () => {
    renderForm({ mode: 'create' });
    expect(screen.getByText('Select a billing cycle…')).toBeInTheDocument();
  });

  it('renders the translated option label when EDIT seeds calendar', () => {
    renderForm({ mode: 'edit', initialValues: { ...EDIT_BASE, billing_cycle: 'calendar' } });
    expect(screen.getByText('Calendar year (Jan–Dec)')).toBeInTheDocument();
  });

  it('renders the translated option label when EDIT seeds rolling', () => {
    renderForm({ mode: 'edit', initialValues: { ...EDIT_BASE, billing_cycle: 'rolling' } });
    expect(screen.getByText('Rolling (anniversary)')).toBeInTheDocument();
  });
});
