/**
 * PR-B task 7 — Company section: registered capital, the website field
 * accepting a bare domain, and the "Additional details" collapsible.
 *
 * Three things pinned here:
 *   1. `registered_capital_thb` renders next to `turnover_thb` — and
 *      `turnover_thb` itself KEEPS its label + gains a hint recording why it
 *      still exists (it gates the F2 turnover band + F8 tier upgrades — the
 *      reviewer asked for a rename, which would silently re-point that rule).
 *   2. `website` accepts a bare domain: `example.com` → `https://example.com`,
 *      an already-complete `https://facebook.com/x` is left unchanged, and
 *      `not a url` is still rejected.
 *   3. `description` / `notes` / `founded_year` / `turnover_thb` /
 *      `registered_capital_thb` sit behind a closed-by-default "Additional
 *      details" `<Collapsible>` that force-opens the moment one of its own
 *      fields fails validation — a closed panel would hide the error and
 *      strand `FormErrorSummary`'s jump link.
 *
 * Rendered against the REAL en.json (not a key-echo mock), same convention as
 * address-section.test.tsx / member-form-error-summary.test.tsx. Tests that
 * only care about a field OTHER than the address use `mode="edit"` with a
 * minimal `initialValues`, mirroring member-form-error-summary.test.tsx's
 * it.each table — edit mode never blocks on the address-completeness gate,
 * so these tests don't need to seed a full TH address just to reach a
 * failed-submit state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const EDIT_BASE = {
  company_name: 'ACME',
  country: 'TH',
  plan_id: PLANS[0]!.plan_id,
  plan_year: 2026,
  primary_contact: {
    first_name: 'A',
    last_name: 'B',
    email: 'a@b.com',
    preferred_language: 'en' as const,
  },
};

function renderEditForm(
  initialValues: Partial<MemberFormValues>,
  onSubmit = vi.fn(),
) {
  const utils = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberForm
        plans={PLANS}
        defaultPlanYear={2026}
        onSubmit={onSubmit}
        submitting={false}
        mode="edit"
        initialValues={{ ...EDIT_BASE, ...initialValues }}
      />
    </NextIntlClientProvider>,
  );
  return { ...utils, onSubmit };
}

function additionalDetailsTrigger() {
  return screen.getByRole('button', { name: /additional details/i });
}

function openAdditionalDetails() {
  fireEvent.click(additionalDetailsTrigger());
}

describe('CompanySection — registered capital keeps turnover_thb intact', () => {
  it('renders registered_capital_thb next to turnover_thb, both reachable once opened', () => {
    renderEditForm({});
    openAdditionalDetails();

    expect(screen.getByLabelText(/registered capital \(thb\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/annual turnover \(thb\)/i)).toBeInTheDocument();
  });

  it('turnover_thb carries a hint explaining why it still exists (not renamed)', () => {
    renderEditForm({});
    openAdditionalDetails();

    expect(
      screen.getByText(/used to place the member in a plan's turnover band/i),
    ).toBeInTheDocument();
  });

  it('a negative registered_capital_thb is rejected and reported on its own field', async () => {
    const onSubmit = vi.fn();
    const { container } = renderEditForm(
      { registered_capital_thb: -5 },
      onSubmit,
    );
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() =>
      expect(container.querySelector('#registered_capital_thb-error')).toHaveTextContent(
        /enter a non-negative amount/i,
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a valid registered_capital_thb reaches onSubmit unchanged', async () => {
    const onSubmit = vi.fn();
    const { container } = renderEditForm(
      { registered_capital_thb: 5_000_000 },
      onSubmit,
    );
    openAdditionalDetails();

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      registered_capital_thb: 5_000_000,
    });
  });
});

describe('CompanySection — website accepts a bare domain', () => {
  it('relabels the field and shows a Facebook-style placeholder', () => {
    renderEditForm({});
    expect(screen.getByText(/website \/ online presence/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/facebook\.com\/yourcompany/i)).toBeInTheDocument();
  });

  it('normalizes a bare domain by prefixing https:// before submit', async () => {
    const onSubmit = vi.fn();
    const { container } = renderEditForm({}, onSubmit);
    fireEvent.change(screen.getByLabelText(/website/i), {
      target: { value: 'example.com' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      website: 'https://example.com',
    });
  });

  it('leaves an already-complete https:// URL unchanged', async () => {
    const onSubmit = vi.fn();
    const { container } = renderEditForm({}, onSubmit);
    fireEvent.change(screen.getByLabelText(/website/i), {
      target: { value: 'https://facebook.com/x' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      website: 'https://facebook.com/x',
    });
  });

  it('still rejects a non-URL string', async () => {
    const onSubmit = vi.fn();
    const { container } = renderEditForm({}, onSubmit);
    fireEvent.change(screen.getByLabelText(/website/i), {
      target: { value: 'not a url' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() =>
      expect(container.querySelector('#website-error')).toHaveTextContent(
        /enter a valid url/i,
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is not collapsed — reachable without opening Additional details', () => {
    renderEditForm({});
    // No click on the trigger — website must already be in the accessible tree.
    expect(screen.getByLabelText(/website/i)).toBeInTheDocument();
  });
});

describe('CompanySection — Additional details collapsible', () => {
  // `keepMounted` on the panel means these fields are ALWAYS in the DOM (a
  // plain querySelector / getByLabelText would find them either way) — the
  // thing that actually changes on open/close is whether they're exposed to
  // the accessibility tree via the native `hidden` attribute on the panel.
  // `getByRole` is the query that respects that (unlike getByLabelText),
  // which is exactly why it's used here instead.
  it('starts collapsed: its fields are excluded from the accessible tree', () => {
    const { container } = renderEditForm({});
    expect(additionalDetailsTrigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('spinbutton', { name: /founded year/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /^notes/i })).toBeNull();
    // But still mounted — proves `keepMounted`, not an unmount/remount churn.
    expect(container.querySelector('#founded_year')).not.toBeNull();
    expect(container.querySelector('#notes')).not.toBeNull();
  });

  it('opens on click and exposes its fields to the accessible tree', () => {
    renderEditForm({});
    openAdditionalDetails();

    expect(additionalDetailsTrigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('spinbutton', { name: /founded year/i })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^notes/i })).toBeInTheDocument();
  });

  it('does NOT wizard the form — Membership/Address/Contact sections render without any click', () => {
    renderEditForm({});
    // Do not open Additional details; the rest of the form must already be
    // fully present (single long form, not a step-by-step wizard).
    expect(screen.getByLabelText(/company name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
  });

  it('force-opens when one of its own fields fails validation, without ever being clicked', async () => {
    const onSubmit = vi.fn();
    // TWO invalid fields (not one) — FormErrorSummary only renders past a
    // single error (member-form.tsx: "Summary only when MORE THAN ONE
    // error"; a lone error is already covered by its inline message + RHF
    // focus). This is the actual scenario the brief warns about: a jump
    // link landing inside a closed section.
    const { container } = renderEditForm(
      { founded_year: 1500, registered_capital_thb: -5 },
      onSubmit,
    );
    // Collapsed at mount — errors don't exist before the first submit.
    expect(additionalDetailsTrigger()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() =>
      expect(additionalDetailsTrigger()).toHaveAttribute('aria-expanded', 'true'),
    );
    // Both fields are now reachable, unhidden — not just "still in the DOM"
    // (that's guaranteed by keepMounted alone) — and the FormErrorSummary's
    // jump links land on live, un-hidden targets.
    expect(screen.getByRole('spinbutton', { name: /founded year/i })).toBeInTheDocument();
    expect(
      screen.getByRole('spinbutton', { name: /registered capital \(thb\)/i }),
    ).toBeInTheDocument();
    expect(container.querySelector('a[href="#founded_year"]')).not.toBeNull();
    expect(container.querySelector('a[href="#registered_capital_thb"]')).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
