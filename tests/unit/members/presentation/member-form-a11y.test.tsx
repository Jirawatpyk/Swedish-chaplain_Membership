/**
 * T053a — Member form a11y unit test.
 *
 * Asserts:
 *   - FR-035 tri-part required-field indicator:
 *     (a) `aria-required="true"` programmatic on every required input,
 *     (b) visible asterisk marker sibling of the label,
 *     (c) form-top note "* fields are required".
 *   - FR-036 autocomplete attrs:
 *     given-name / family-name / email / tel / organization / url / bday.
 *   - FR-037 title is enforced at the page level (generateMetadata) —
 *     this test only covers the form component surface.
 *
 * Uses React Testing Library + jsdom (via vitest.config.ts). Mocks
 * next-intl's `useTranslations` to return the translation key so the
 * test doesn't depend on the messages JSON being loaded.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

function byId(container: HTMLElement, id: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`input #${id} not found`);
  return el;
}

// next-intl mock must register BEFORE the form import picks up the hook.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  // PR-B task 5 — CountryCombobox (rendered inside CompanySection) calls
  // useLocale() to resolve i18n-iso-countries' locale data; the minimal
  // mock above is a full replace (not `importOriginal` partial), so it
  // must also stub this export or the render throws.
  useLocale: () => 'en',
}));

import { MemberForm, type PlanOption } from '@/components/members/member-form';

const PLANS: PlanOption[] = [
  {
    plan_id: 'premium',
    plan_year: 2026,
    display_name: 'Premium — 2026',
  },
];

function renderForm() {
  return render(
    <MemberForm
      plans={PLANS}
      defaultPlanYear={2026}
      onSubmit={() => undefined}
      submitting={false}
    />,
  );
}

describe('MemberForm FR-035 tri-part required indicator', () => {
  it('renders the form-top required fields note', () => {
    const { container } = renderForm();
    const note = container.querySelector('#required-fields-note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toBe('requiredNote');
  });

  it.each([
    ['company_name', true],
    ['country', true],
    ['plan_year', true],
    ['first_name', true],
    ['last_name', true],
    ['contact_email', true],
    ['legal_entity_type', false],
    ['tax_id', false],
    ['website', false],
    ['contact_phone', false],
  ])(
    '#%s aria-required matches expected %s',
    (id, expected) => {
      const { container } = renderForm();
      const input = byId(container, id);
      const actual = input.getAttribute('aria-required');
      expect(actual === 'true').toBe(expected);
    },
  );

  it.each(['company_name', 'country', 'plan_year'])(
    '#%s label contains visible asterisk',
    (id) => {
      const { container } = renderForm();
      const label = container.querySelector(`label[for="${id}"]`);
      expect(label?.textContent ?? '').toContain('*');
    },
  );

  it.each(['first_name', 'last_name', 'contact_email'])(
    'primary contact #%s label contains asterisk',
    (id) => {
      const { container } = renderForm();
      const label = container.querySelector(`label[for="${id}"]`);
      expect(label?.textContent ?? '').toContain('*');
    },
  );
});

describe('MemberForm FR-036 autocomplete attrs', () => {
  // PR-B task 5 — `country` dropped from this table: it is now a searchable
  // combobox (a `role=combobox` trigger <button>, not a text <input>), so
  // browser autocomplete has nothing to fill in — `autocomplete="country"`
  // only ever applied to a free-typed 2-letter text field.
  it.each([
    ['company_name', 'organization'],
    ['website', 'url'],
    ['first_name', 'given-name'],
    ['last_name', 'family-name'],
    ['contact_email', 'email'],
    ['contact_phone', 'tel'],
    ['role_title', 'organization-title'],
  ])('#%s has autocomplete=%s', (id, expected) => {
    const { container } = renderForm();
    const input = byId(container, id);
    expect(input.getAttribute('autocomplete')).toBe(expected);
  });

  it('contact_email has type=email', () => {
    const { container } = renderForm();
    const email = byId(container, 'contact_email');
    expect(email.getAttribute('type')).toBe('email');
  });

  it('contact_phone has type=tel', () => {
    const { container } = renderForm();
    const phone = byId(container, 'contact_phone');
    expect(phone.getAttribute('type')).toBe('tel');
  });

  it('website has type=url', () => {
    const { container } = renderForm();
    const url = byId(container, 'website');
    expect(url.getAttribute('type')).toBe('url');
  });
});

/**
 * T2 (round-3 review): member-form notes field coverage.
 *
 * `notes` is admin-only metadata (max 4000 chars). It is intentionally
 * NOT required — so no aria-required and no asterisk marker — but the
 * textarea still needs to be:
 *   - reachable by id (for label association),
 *   - labelled via `<label for>`,
 *   - capped by `maxLength={4000}` so the browser prevents over-long
 *     drafts before server-side validation.
 * The optional-field treatment also matches FR-035 (tri-part indicator
 * only applies to required fields).
 */
describe('MemberForm notes field (T2 — round-3)', () => {
  it('renders a textarea with id="notes"', () => {
    const { container } = renderForm();
    const notes = container.querySelector<HTMLTextAreaElement>('#notes');
    expect(notes).not.toBeNull();
    expect(notes?.tagName).toBe('TEXTAREA');
  });

  it('is NOT aria-required (optional admin metadata)', () => {
    const { container } = renderForm();
    const notes = container.querySelector<HTMLTextAreaElement>('#notes');
    expect(notes?.getAttribute('aria-required')).not.toBe('true');
  });

  it('enforces maxLength=4000 on the textarea', () => {
    const { container } = renderForm();
    const notes = container.querySelector<HTMLTextAreaElement>('#notes');
    expect(notes?.maxLength).toBe(4000);
  });

  it('has a <label> associated via `for="notes"`', () => {
    const { container } = renderForm();
    const label = container.querySelector('label[for="notes"]');
    expect(label).not.toBeNull();
    // Optional field — label MUST NOT have the red asterisk marker.
    expect(label?.textContent ?? '').not.toContain('*');
  });

  it('exposes a placeholder (via i18n key)', () => {
    const { container } = renderForm();
    const notes = container.querySelector<HTMLTextAreaElement>('#notes');
    // useTranslations mock returns the key verbatim — we assert the
    // placeholder attribute exists (content is i18n-owned, not tested here).
    // The `tf` translator is scoped to admin.members.create.fields, so
    // the mock returns the last segment of the key.
    expect(notes?.placeholder).toBe('notesPlaceholder');
  });
});
