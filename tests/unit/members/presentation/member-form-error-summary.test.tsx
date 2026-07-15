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

  // dda2437e wired aria-invalid / aria-describedby / FieldError / a summary
  // entry onto nine fields that previously had a zod max() rule but rendered
  // NONE of that — a legacy-DB-seeded over-length value (the HTML maxLength
  // attribute stops a human typing past the limit, but not a seeded
  // defaultValue) made submit silently do nothing, with no explanation.
  // Only `city` had a regression test; this covers the other eight so a
  // future edit that drops the wiring on any one of them goes red here
  // instead of waiting for a bug report. `role_title` lives at RHF path
  // `primary_contact.role_title` but its DOM id is the bare `role_title` —
  // same as its error-summary key.
  // legal_entity_type dropped from this table (PR-A Task 3b): it is now a
  // closed Select over LEGAL_ENTITY_TYPES, not free text — there is no
  // "exceeds its max length" scenario left to exercise on it. Its own
  // closed-catalogue behaviour is pinned in member-form-schema.test.ts.
  it.each([
    ['description', 2000],
    ['notes', 4000],
    ['address_line1', 200],
    ['address_line2', 200],
    ['province', 100],
    ['postal_code', 20],
    ['role_title', 100],
  ] as const)(
    'shows an inline error and a summary entry when %s exceeds its max length',
    async (id, max) => {
      const plans = [
        { plan_id: 'plan-1', plan_year: 2026, display_name: 'Standard 2026' },
      ];
      const overLength = 'x'.repeat(max + 1);
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
              // FormErrorSummary only renders when >1 error (ux-standards §
              // 11.3, enforced in member-form.tsx via `summaryItems.length >
              // 1 ? summaryItems : []`) — a lone over-length field would
              // pass its inline #<id>-error assertion but never reach the
              // summary, so pair it with a permanent second error. `city`
              // is not in this it.each table (it has its own dedicated
              // test above), so it never collides with the field under test.
              city: 'x'.repeat(101),
              ...(id === 'role_title'
                ? {}
                : { [id]: overLength }),
              primary_contact: {
                first_name: 'A',
                last_name: 'B',
                email: 'a@b.com',
                preferred_language: 'en',
                ...(id === 'role_title' ? { role_title: overLength } : {}),
              },
            }}
          />
        </NextIntlClientProvider>,
      );
      const form = container.querySelector('form');
      if (!form) throw new Error('member form did not render');
      fireEvent.submit(form);

      // Scope to `#<id>-error` rather than a bare screen.findByText(...):
      // several of these fields share max(100) and therefore the SAME
      // rendered message, which would make a text-only query ambiguous.
      await waitFor(() => {
        expect(container.querySelector(`#${id}-error`)).toHaveTextContent(
          new RegExp(`please use ${max} characters or fewer`, 'i'),
        );
      });

      const input = container.querySelector(`#${id}`);
      expect(input).not.toBeNull();
      expect(input).toHaveAttribute('aria-invalid', 'true');
      const describedBy = input?.getAttribute('aria-describedby') ?? '';
      expect(describedBy.split(' ')).toContain(`${id}-error`);
      if (id === 'notes') {
        // notes carries a permanent hint paragraph — the error must be
        // ADDED alongside it, not replace it (dda2437e regression: an
        // earlier draft overwrote aria-describedby and orphaned the hint).
        expect(describedBy.split(' ')).toContain('notes-hint');
      }

      // Summary jump link — the field must contribute a #<id> entry, not
      // just render its own inline error.
      expect(container.querySelector(`a[href="#${id}"]`)).not.toBeNull();
    },
  );

  // Root-cause regression (maintainer bug report): every empty required
  // field resolves to the SAME generic zod message ("This field is
  // required."), so a summary built from the message alone rendered a stack
  // of identical, anonymous lines — the admin had to click each link to
  // find out which field it even referred to. Fixed by naming the field in
  // the link text.
  it('renders distinguishable summary lines that each name their own field, even though the underlying message is identical', async () => {
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

    await waitFor(() => {
      expect(container.querySelector('a[href="#company_name"]')).not.toBeNull();
    });

    // company_name and first_name both fail their bare min(1) rule — SAME
    // zod message — but must read as two different lines.
    const companyLink = container.querySelector('a[href="#company_name"]');
    const firstNameLink = container.querySelector('a[href="#first_name"]');
    expect(companyLink).not.toBeNull();
    expect(firstNameLink).not.toBeNull();
    expect(companyLink?.textContent).not.toBe(firstNameLink?.textContent);
    expect(companyLink).toHaveTextContent(/company name/i);
    expect(firstNameLink).toHaveTextContent(/first name/i);
  });

  // PR-B task 8 rendered `ContactFields` twice (primary + secondary), both
  // sharing the SAME `admin.members.create.fields.*` label keys (Email,
  // Phone, …). Without disambiguation, two empty `email` fields would
  // collide on an identical line — "Email — This field is required." twice
  // — exactly the bug this whole fix exists to prevent.
  it('disambiguates the secondary contact from the primary contact when both share the same missing field', async () => {
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
    // Expand the secondary contact fieldset so its (also-empty) required
    // fields register too.
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );

    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        container.querySelector('a[href="#secondary_contact_email"]'),
      ).not.toBeNull();
    });

    const primaryEmailLink = container.querySelector('a[href="#contact_email"]');
    const secondaryEmailLink = container.querySelector(
      'a[href="#secondary_contact_email"]',
    );
    expect(primaryEmailLink).not.toBeNull();
    expect(secondaryEmailLink).not.toBeNull();
    // Both lines fail the identical "This field is required." rule on an
    // "Email" field — the rendered text must still differ, and the
    // secondary line must clearly name itself as the secondary contact.
    expect(primaryEmailLink?.textContent).not.toBe(secondaryEmailLink?.textContent);
    expect(secondaryEmailLink).toHaveTextContent(/secondary contact/i);
    expect(secondaryEmailLink).toHaveTextContent(/email/i);
  });
});
