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
  // 065 §5.1 — required pick; seed it so submit-path tests aren't blocked by it.
  billing_cycle: 'rolling' as const,
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

/**
 * 059 / PR-A Task 3b — legal_entity_type is now a closed Select over
 * LEGAL_ENTITY_TYPES, not a free-text `<Input>`. NOTE: these tests are
 * deliberately STATIC (no simulated open-dropdown-then-click-an-item
 * flow) — this repo has no precedent for driving a Base UI `<Select>`
 * popup through jsdom (its popup portals + animates, the same class of
 * thing that hangs Base UI `<Dialog>` under RTL — see
 * base-ui-dialog-jsdom-transition-hang in project memory), and the
 * VAT-seeding DECISION logic is separately covered exhaustively, with zero
 * DOM risk, in resolve-vat-seed.test.ts.
 */
describe('CompanySection — legal_entity_type is a closed Select (PR-A Task 3b)', () => {
  it('renders a Select trigger at #legal_entity_type, not a free-text input', () => {
    const { container } = renderEditForm({});
    expect(container.querySelector('input#legal_entity_type')).toBeNull();
    expect(container.querySelector('#legal_entity_type')).not.toBeNull();
  });

  it('is NOT labelled "Member Type" — that name is already taken', () => {
    // This field is the member's LEGAL FORM (บริษัทจำกัด / มูลนิธิ / บุคคลธรรมดา);
    // it exists to drive the §86/4 buyer particulars on a tax invoice. It was
    // briefly renamed "Member Type", which is wrong on three counts:
    //   - `admin.plans.fields.memberType` and `memberTypeScope` ALREADY render as
    //     "Member type" and mean the PLAN's scope (company / individual / both) —
    //     two different fields would answer to one name in the same app;
    //   - the same form has a `Plan` field, so it would read
    //     "Member Type: Individual" directly above "Plan: Individual";
    //   - `scripts/import-members/columns.ts` already lists 'member type' as an
    //     alias for `tier`, i.e. this codebase has been fooled by that name once.
    const { container } = renderEditForm({});
    const label = container.querySelector('label[for="legal_entity_type"]');
    expect(label?.textContent).toContain('Legal entity type');
  });

  it('shows the placeholder when no type is recorded', () => {
    renderEditForm({ legal_entity_type: undefined });
    expect(screen.getByText('Select a type…')).toBeInTheDocument();
  });

  it('shows the resolved, translated label for an already-recorded type', () => {
    const { container } = renderEditForm({ legal_entity_type: 'limited_company' });
    const trigger = container.querySelector('#legal_entity_type');
    expect(trigger?.textContent).toContain('Limited company');
  });

  it('is NOT aria-required — the field stays genuinely optional', () => {
    const { container } = renderEditForm({});
    const trigger = container.querySelector('#legal_entity_type');
    expect(trigger?.getAttribute('aria-required')).not.toBe('true');
  });
});

describe('CompanySection — entity-type explanation popup (PR-A Task 3b)', () => {
  it('renders a help trigger with an accessible name', () => {
    renderEditForm({});
    expect(
      screen.getByRole('button', { name: /help.*legal entity types explained/i }),
    ).toBeInTheDocument();
  });

  // Defensive-redundancy guard, not a documented Base UI footgun: Base UI's
  // PopoverTrigger already renders `type="button"` on its own (`useButton`),
  // so this popover — which lives inside <form onSubmit> — would not
  // actually submit the form even without the explicit prop. This pins the
  // explicit `type="button"` (harmless belt-and-braces) and confirms
  // clicking the help icon never submits the form either way.
  it('the help trigger is type=button (explicit, defensive) and clicking it does NOT submit the form', () => {
    const onSubmit = vi.fn();
    renderEditForm({}, onSubmit);
    const help = screen.getByRole('button', {
      name: /help.*legal entity types explained/i,
    });
    expect(help).toHaveAttribute('type', 'button');
    fireEvent.click(help);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/**
 * 059 / PR-A Task 3b — the class of bug PR-B shipped a Critical for: an
 * effect (or, here, any mount-time write) that silently rewrites a field
 * the admin never touched. There is no useEffect/useWatch in this seeding
 * path at all (it lives entirely inside the Select's onValueChange — a
 * user-initiated event that cannot fire on mount) — this test proves the
 * ABSENCE of the bug end to end: loading the Edit form of a member whose
 * RECORDED is_vat_registered DISAGREES with their entity type's default
 * must not silently "correct" it.
 */
describe('CompanySection — VAT-registrant seeding never fires on mount (PR-A Task 3b)', () => {
  it('loading the edit form with a mismatched recorded VAT flag leaves it untouched', () => {
    // company's VAT_DEFAULT_BY_CODE is `true`; this member's RECORDED flag
    // is `false`. If anything auto-seeded on mount, this would flip.
    renderEditForm({ legal_entity_type: 'company', is_vat_registered: false });
    const checkbox = screen.getByRole('checkbox', {
      name: /this member is registered for vat/i,
    });
    expect(checkbox).not.toBeChecked();
  });

  it('loading the edit form with a recorded `true` VAT flag on a normally-false-default type leaves it untouched', () => {
    // sole_proprietor's VAT_DEFAULT_BY_CODE is `false`; this member is
    // RECORDED as `true` (above the turnover threshold, per the domain
    // file's own §77/1 note). Mount must not "correct" this either.
    renderEditForm({
      legal_entity_type: 'sole_proprietor',
      is_vat_registered: true,
    });
    const checkbox = screen.getByRole('checkbox', {
      name: /this member is registered for vat/i,
    });
    expect(checkbox).toBeChecked();
  });
});

/**
 * 060 / Task 9 — the Tax-ID field shows a required marker ONLY when the member is
 * a VAT registrant (the zod rule at member-form/schema.ts already enforces
 * registrant ⇒ tax_id). A permanent asterisk would lie to the 37/150 TSCC members
 * with no TIN at all (individuals, state enterprises, foundations). `aria-required`
 * is the load-bearing a11y signal — RequiredMark is aria-hidden.
 */
describe('CompanySection — conditional Tax-ID required marker (Task 9)', () => {
  it('a VAT registrant: Tax ID shows the asterisk AND aria-required="true"', () => {
    const { container } = renderEditForm({ is_vat_registered: true });
    const label = container.querySelector('label[for="tax_id"]');
    expect(label?.textContent).toContain('*');
    expect(container.querySelector('#tax_id')?.getAttribute('aria-required')).toBe('true');
  });

  it('a NON-registrant: Tax ID shows no asterisk and is not aria-required', () => {
    const { container } = renderEditForm({ is_vat_registered: false });
    const label = container.querySelector('label[for="tax_id"]');
    expect(label?.textContent).not.toContain('*');
    expect(container.querySelector('#tax_id')?.getAttribute('aria-required')).not.toBe('true');
  });
});
