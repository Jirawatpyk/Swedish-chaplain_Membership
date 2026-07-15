/**
 * PR-B task 8 — Secondary contact: additive disclosure, not a negative
 * opt-out.
 *
 * The reviewer asked for a "No secondary contact" checkbox, unchecked by
 * default. That is NOT what is built here: an unchecked-by-default box
 * makes a second natural person's PII required by default (friction on the
 * majority path, inverts GDPR Art. 25(2) — data protection BY DEFAULT) and
 * is a negative checkbox users reliably mis-parse. Instead: a
 * `+ Add a secondary contact` button reveals the fieldset; Remove clears
 * the underlying form VALUE (not just the widget) so a filled-then-removed
 * secondary contact never rides along on submit.
 *
 * Rendered against the real en.json (not a key-echo mock) so the copy +
 * i18n-key-resolution assertions are meaningful — mirrors
 * address-section.test.tsx / member-form-error-summary.test.tsx.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  MemberForm,
  type MemberFormValues,
  type PlanOption,
} from '@/components/members/member-form';

// Task 8 (GDPR Art. 14 checkbox) — Base UI Checkbox uses PointerEvent
// internally; jsdom lacks it. Same polyfill as members-table-selection.test.tsx.
beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

const PLANS: PlanOption[] = [
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
];

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

/**
 * A fully-valid CREATE baseline, seeded via `initialValues` rather than
 * driven through the DOM: `country: 'SE'` keeps address_line1/city as plain
 * `<input>`s (avoids the PR-B task 6 Thai postcode Combobox machinery,
 * covered by address-section.test.tsx) and only address_line1 + city are
 * required for a non-TH member (create-mode superRefine in schema.ts).
 * `plan_id` is a Select that only accepts a real user click — seeding it
 * here avoids driving that interaction in every test in this file, which
 * only cares about the secondary-contact fieldset.
 */
const VALID_INITIAL_VALUES: Partial<MemberFormValues> = {
  company_name: 'Acme Co',
  country: 'SE',
  address_line1: '99 Main St',
  city: 'Stockholm',
  plan_id: 'premium',
  plan_year: 2026,
  primary_contact: {
    first_name: 'Anna',
    last_name: 'Andersson',
    email: 'anna@example.com',
    preferred_language: 'en',
  },
};

function renderForm(onSubmit = vi.fn()) {
  const utils = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberForm
        plans={PLANS}
        defaultPlanYear={2026}
        onSubmit={onSubmit}
        submitting={false}
        initialValues={VALID_INITIAL_VALUES}
      />
    </NextIntlClientProvider>,
  );
  return { ...utils, onSubmit };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('SecondaryContactSection — additive, not a negative opt-out', () => {
  it('is collapsed by default: no secondary_contact_* fields in the DOM, only the Add button', () => {
    renderForm();
    expect(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    ).toBeInTheDocument();
    expect(document.getElementById('secondary_contact_first_name')).toBeNull();
    expect(document.getElementById('secondary_contact_email')).toBeNull();
  });

  it('clicking Add reveals the fieldset with required first/last/email + a Remove action', () => {
    renderForm();
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );

    expect(byId('secondary_contact_first_name')).toBeInTheDocument();
    expect(byId('secondary_contact_last_name')).toBeInTheDocument();
    expect(byId('secondary_contact_email')).toBeInTheDocument();
    expect(byId('secondary_contact_phone')).toBeInTheDocument();
    expect(byId('secondary_contact_first_name')).toHaveAttribute('required');
    expect(byId('secondary_contact_email')).toHaveAttribute('required');
    // No date-of-birth on the secondary contact (primary-only, plan-driven).
    expect(document.getElementById('secondary_contact_date_of_birth')).toBeNull();

    expect(
      screen.getByRole('button', { name: /remove secondary contact/i }),
    ).toBeInTheDocument();
    // The Add trigger is gone once expanded.
    expect(
      screen.queryByRole('button', { name: /add a secondary contact/i }),
    ).toBeNull();
  });

  it('clicking Remove hides the fieldset and brings back the Add trigger', () => {
    renderForm();
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /remove secondary contact/i }),
    );

    expect(document.getElementById('secondary_contact_first_name')).toBeNull();
    expect(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    ).toBeInTheDocument();
  });

  it('blocks submit with a required-field error when added but left incomplete', async () => {
    const { container, onSubmit } = renderForm();
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );
    // Leave every secondary field blank.

    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(container.querySelector('#secondary_contact_first_name-error'))
        .not.toBeNull();
    });
    expect(onSubmit).not.toHaveBeenCalled();
    // Jump link contributed to the top-of-form error summary.
    expect(
      container.querySelector('a[href="#secondary_contact_first_name"]'),
    ).not.toBeNull();
  });

  it('rejects a secondary email identical to the primary email, WITHOUT submitting', async () => {
    const { container, onSubmit } = renderForm();
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );
    fireEvent.change(byId('secondary_contact_first_name'), {
      target: { value: 'Björn' },
    });
    fireEvent.change(byId('secondary_contact_last_name'), {
      target: { value: 'Svensson' },
    });
    // Same email as the primary contact filled above.
    fireEvent.change(byId('secondary_contact_email'), {
      target: { value: 'anna@example.com' },
    });

    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(byId('secondary_contact_email')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits secondary_contact with the filled values when everything is valid', async () => {
    const { container, onSubmit } = renderForm();
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );
    fireEvent.change(byId('secondary_contact_first_name'), {
      target: { value: 'Björn' },
    });
    fireEvent.change(byId('secondary_contact_last_name'), {
      target: { value: 'Svensson' },
    });
    fireEvent.change(byId('secondary_contact_email'), {
      target: { value: 'bjorn@example.com' },
    });
    // Task 8 (GDPR Art. 14) — the attestation checkbox blocks submit until
    // checked; without this click the schema's refine rejects the request.
    fireEvent.click(
      screen.getByRole('checkbox', { name: /informed this person/i }),
    );

    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0]?.[0];
    expect(values.secondary_contact).toMatchObject({
      first_name: 'Björn',
      last_name: 'Svensson',
      email: 'bjorn@example.com',
      art14_attested: true,
    });
  });

  it('blocks submit when the fieldset is filled but the Art. 14 attestation checkbox is left unchecked (Task 8)', async () => {
    const { container, onSubmit } = renderForm();
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );
    fireEvent.change(byId('secondary_contact_first_name'), {
      target: { value: 'Björn' },
    });
    fireEvent.change(byId('secondary_contact_last_name'), {
      target: { value: 'Svensson' },
    });
    fireEvent.change(byId('secondary_contact_email'), {
      target: { value: 'bjorn@example.com' },
    });
    // Attestation checkbox deliberately left unchecked.

    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        container.querySelector('#secondary_contact_art14_attested-error'),
      ).not.toBeNull();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Remove clears the underlying form VALUE, not just the widget — a filled-then-removed secondary contact never rides along on submit', async () => {
    const { container, onSubmit } = renderForm();
    fireEvent.click(
      screen.getByRole('button', { name: /add a secondary contact/i }),
    );
    fireEvent.change(byId('secondary_contact_first_name'), {
      target: { value: 'Björn' },
    });
    fireEvent.change(byId('secondary_contact_last_name'), {
      target: { value: 'Svensson' },
    });
    fireEvent.change(byId('secondary_contact_email'), {
      target: { value: 'bjorn@example.com' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /remove secondary contact/i }),
    );

    const form = container.querySelector('form');
    if (!form) throw new Error('member form did not render');
    fireEvent.submit(form);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0]?.[0];
    expect(values.secondary_contact).toBeUndefined();
  });

  it('does not render the secondary-contact trigger on the EDIT form', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MemberForm
          plans={PLANS}
          defaultPlanYear={2026}
          onSubmit={vi.fn()}
          submitting={false}
          mode="edit"
          initialValues={{
            company_name: 'Acme',
            country: 'TH',
            plan_id: 'premium',
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
    expect(
      screen.queryByRole('button', { name: /add a secondary contact/i }),
    ).toBeNull();
  });
});
