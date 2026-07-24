/**
 * WP2 — the plan picker surfaces the annual fee.
 *
 * Rendered against the REAL en.json (same convention as
 * membership-section-billing-cycle.test.tsx). The collapsed trigger shows
 * the plan NAME only (TranslatedSelectValue stays name-only); the fee (with
 * an sr-only "Annual fee" prefix) appears inside the option list once opened.
 *
 * The base-ui Select renders its option list in a portal on interaction —
 * `fireEvent.click` opens it reliably here (real timers). The open-list fee
 * assertion is best-effort per the plan; the reliable contract is the
 * name-only trigger + the sr-only-prefixed fee node.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('MembershipSection — annual-fee display (WP2)', () => {
  it('collapsed trigger shows the plan NAME only (fee not rendered until the list opens)', () => {
    renderForm();
    expect(screen.getByText('Premium — 2026')).toBeInTheDocument();
    // The fee lives only inside the (closed) option list — not the trigger.
    expect(screen.queryByText(/50,000\.00/)).toBeNull();
  });

  it('shows the fee with an sr-only "Annual fee" prefix once the option list opens', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('combobox', { name: 'Plan' }));
    // sr-only prefix span (its own direct text) + the formatted fee (the
    // wrapper's own direct text) — both appear only after the list opens.
    expect(await screen.findByText(/Annual fee/)).toBeInTheDocument();
    expect(screen.getByText(/50,000\.00/)).toBeInTheDocument();
  });
});
