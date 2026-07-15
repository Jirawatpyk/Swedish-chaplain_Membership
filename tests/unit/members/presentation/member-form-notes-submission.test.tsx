/**
 * MemberForm notes — the value actually reaches onSubmit (create mode).
 *
 * PR-0 finding 3 (whole-branch review): neither existing "notes" test closes
 * the loop this branch's own thesis rests on ("the value never left the
 * browser"). `create-member-client.test.tsx` MOCKS MemberForm entirely — it
 * tests `toPayload`, not the form. `member-form-error-summary.test.tsx` seeds
 * `notes` through `initialValues`, which `zodResolver` reads off RHF's
 * internal `_formValues` (built from `defaultValues`), NOT the DOM — so it
 * stays green even if `{...register('notes')}` were deleted from the
 * Textarea. This test renders the real MemberForm (real en.json, create
 * mode, MemberForm NOT mocked), TYPES into the Notes textarea via
 * `fireEvent.change`, submits, and asserts the value the `onSubmit` callback
 * actually received.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberForm, type PlanOption } from '@/components/members/member-form';

beforeEach(() => {
  // RHF async validation needs real timers (tests/setup.ts installs fake ones).
  vi.useRealTimers();
});

const PLANS: PlanOption[] = [
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
];

describe('MemberForm notes — reaches onSubmit via the real DOM (create mode)', () => {
  it('submits the typed Notes value, not just an initialValues echo', async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={onSubmit}
          submitting={false}
          initialValues={{
            company_name: 'Acme Co',
            country: 'TH',
            // PR-B task 6 — CREATE mode now gates submit on a complete TH
            // address (schema.ts superRefine). Seeded here so this test can
            // isolate what it actually asserts: that the typed `notes`
            // value reaches `onSubmit`, not the address completeness rule.
            address_line1: '123 Sukhumvit Rd',
            sub_district: 'คลองตันเหนือ',
            city: 'เขตวัฒนา',
            province: 'กรุงเทพมหานคร',
            postal_code: '10110',
            plan_id: PLANS[0]!.plan_id,
            plan_year: 2026,
            // 065 §5.1 — required pick; seed it so submit isolates `notes`.
            billing_cycle: 'rolling',
            primary_contact: {
              first_name: 'A',
              last_name: 'B',
              email: 'a@b.com',
              preferred_language: 'en',
            },
          }}
        />
      </NextIntlClientProvider>,
    );

    // The DOM interaction is the whole point — initialValues seeds the
    // OTHER required fields, but notes itself is typed, exactly like an
    // admin would, so the assertion below can only pass via the real
    // register('notes') → RHF → zodResolver → onSubmit path.
    fireEvent.change(screen.getByLabelText(/notes/i), {
      target: { value: 'Renewal handled by finance' },
    });

    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      notes: 'Renewal handled by finance',
    });
  });
});
