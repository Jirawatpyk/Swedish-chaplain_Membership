/**
 * MemberForm error summary (audit XF-09).
 *
 * A long form (~15 fields) must surface a focusable error summary at the top
 * on a failed submit with >1 error (ux-standards § 11.3), each row a link that
 * jumps to the offending field. Single-error submits stay inline-only (covered
 * by member-form-server-field-error.test.tsx). Rendered against real en.json.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MemberForm } from '@/components/members/member-form';

beforeEach(() => {
  // RHF async validation needs real timers (tests/setup.ts installs fake ones).
  vi.useRealTimers();
});

describe('MemberForm error summary (XF-09)', () => {
  it('renders a focusable summary with jump links when >1 field fails on submit', async () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={[]}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
        />
      </NextIntlClientProvider>,
    );
    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    // Empty submit fails company_name, plan_id, first/last name, email (>1).
    const heading = await screen.findByText(
      'Please fix the following before continuing:',
    );
    const region = heading.closest('[role="alert"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('tabindex')).toBe('-1');

    const links = region?.querySelectorAll('a[href^="#"]') ?? [];
    expect(links.length).toBeGreaterThan(1);
    // The first required field is anchored so the link jumps straight to it.
    expect(region?.querySelector('a[href="#company_name"]')).not.toBeNull();
  });

  it('shows an inline error and a summary entry when city exceeds its max length', async () => {
    const plans = [
      { plan_id: 'plan-1', plan_year: 2026, display_name: 'Standard 2026' },
    ];
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={plans}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{
            company_name: 'ACME',
            country: 'TH',
            plan_id: plans[0]!.plan_id,
            plan_year: 2026,
            city: 'x'.repeat(101),
            province: 'y'.repeat(101),
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
    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    // shared.validation.tooLong resolves to "Please use {max} characters or
    // fewer." (not "at most N") — asserting against the real en.json copy.
    // province also exceeds max(100) with the SAME message, so a plain
    // screen.findByText(...) is ambiguous (2 matches); scope to #city-error.
    await waitFor(() => {
      expect(container.querySelector('#city-error')).toHaveTextContent(
        /please use 100 characters or fewer/i,
      );
    });
    expect(screen.getByLabelText(/^city/i)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // Summary jump link — the field must contribute a #city entry, not just
    // render its own inline error.
    expect(container.querySelector('a[href="#city"]')).not.toBeNull();
  });
});
