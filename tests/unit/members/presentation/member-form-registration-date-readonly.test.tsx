/**
 * PR-0 Task 2: registration_date is read-only on edit.
 *
 * Today the Registration date input renders in edit mode, is seeded from the
 * DB, and is silently discarded on save — buildFieldPayload never sends it
 * and updateMemberSchema is `.strict()` without the key, so sending it would
 * 400 anyway. It also anchors the F8 renewal cycle, so making it editable
 * would require re-anchoring the in-flight cycle's period and refusing the
 * change once an invoice has been issued against it — a separate, deferred
 * use case (see spec § 13). The fix here is read-only in edit mode, not
 * "make the save work".
 *
 * `readOnly` (not `disabled`) is deliberate: a disabled input is dropped
 * from react-hook-form's state and is unreachable by keyboard — a WCAG
 * regression. `readOnly` keeps the value visible, focusable, and announced.
 *
 * Rendered against real en.json (not a key-echo mock, unlike
 * member-form-a11y.test.tsx) because the assertions below need the actual
 * hint copy — same pattern as member-form-error-summary.test.tsx.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberForm, type PlanOption } from '@/components/members/member-form';

const PLANS: PlanOption[] = [
  {
    plan_id: 'premium',
    plan_year: 2026,
    display_name: 'Premium — 2026',
  },
];

describe('MemberForm registration_date read-only on edit', () => {
  it('renders registration_date as read-only in edit mode', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{ registration_date: '2024-03-01' }}
        />
      </NextIntlClientProvider>,
    );

    // 122 US5b-2 — the board's read-only text field with the date as people
    // read it (the stored ISO value is not editable here).
    const input = screen.getByLabelText(/registration date/i);
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveValue('1 Mar 2024');
    expect(
      screen.getByText(/set at member creation and cannot be changed here/i),
    ).toBeInTheDocument();
  });

  it('leaves registration_date editable in create mode', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByLabelText(/registration date/i)).not.toHaveAttribute(
      'readonly',
    );
  });

  it('is an AURA date picker in create mode (typed or picked; 122 US5b-2)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm plans={PLANS} defaultPlanYear={2026} onSubmit={vi.fn()} submitting={false} />
      </NextIntlClientProvider>,
    );
    const input = screen.getByLabelText(/registration date/i);
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAccessibleDescription(enMessages.admin.members.create.fields.registrationDateHint);
  });
});
