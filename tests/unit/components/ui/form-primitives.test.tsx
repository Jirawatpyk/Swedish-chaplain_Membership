/**
 * Shared form primitives (audit XF-05 / XF-06 / XF-09):
 *   - RequiredMark    — aria-hidden asterisk
 *   - EmailInput      — type/inputmode/autocomplete defaults, overridable
 *   - FormErrorSummary — focusable error list with jump links
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { RequiredMark } from '@/components/ui/required-mark';
import { EmailInput } from '@/components/ui/email-input';
import {
  FormErrorSummary,
  type FormErrorSummaryItem,
} from '@/components/ui/form-error-summary';

describe('RequiredMark', () => {
  it('renders an aria-hidden asterisk so screen readers do not read "star"', () => {
    const { container } = render(<RequiredMark />);
    const span = container.querySelector('span');
    expect(span?.textContent).toBe('*');
    expect(span?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('EmailInput', () => {
  it('bakes in type/inputmode/autocomplete for the email keyboard', () => {
    const { container } = render(<EmailInput id="email" />);
    const input = container.querySelector('#email');
    expect(input?.getAttribute('type')).toBe('email');
    expect(input?.getAttribute('inputmode')).toBe('email');
    expect(input?.getAttribute('autocomplete')).toBe('email');
  });

  it('lets a form override autoComplete (e.g. sign-in uses "username")', () => {
    const { container } = render(
      <EmailInput id="email" autoComplete="username" />,
    );
    const input = container.querySelector('#email');
    expect(input?.getAttribute('autocomplete')).toBe('username');
    // inputmode default still applies.
    expect(input?.getAttribute('inputmode')).toBe('email');
  });
});

describe('FormErrorSummary', () => {
  const items: FormErrorSummaryItem[] = [
    { fieldId: 'company_name', label: 'Company name', message: 'Company name is required' },
    { fieldId: 'tax_id', label: 'Tax ID', message: 'Tax ID is invalid' },
  ];

  it('renders nothing when there are no errors', () => {
    const { container } = render(
      <FormErrorSummary title="Fix the following:" items={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a role=alert region with one jump link per error', () => {
    const { getByRole, container } = render(
      <FormErrorSummary title="Fix the following:" items={items} />,
    );
    const region = getByRole('alert');
    expect(region.getAttribute('tabindex')).toBe('-1');
    const link = container.querySelector('a[href="#tax_id"]');
    expect(link).not.toBeNull();
    expect(link).toHaveTextContent('Tax ID is invalid');
  });

  it('takes focus when the error set appears (delivers keyboard/SR users to it)', () => {
    const { getByRole } = render(
      <FormErrorSummary title="Fix the following:" items={items} />,
    );
    expect(document.activeElement).toBe(getByRole('alert'));
  });

  // Root-cause regression: a generic zod message ("This field is
  // required.") is IDENTICAL across every empty required field. Before this
  // fix the link text was `item.message` alone, so a failed submit with
  // several empty fields rendered a stack of indistinguishable lines naming
  // no field — the admin had to click each one to find out which field it
  // meant. The fix renders `item.label` alongside `item.message`.
  it('names the field in the link text, so two errors with the SAME message still render distinguishable lines', () => {
    const sameMessage: FormErrorSummaryItem[] = [
      { fieldId: 'company_name', label: 'Company name', message: 'This field is required.' },
      { fieldId: 'plan_id', label: 'Plan', message: 'This field is required.' },
    ];
    const { container } = render(
      <FormErrorSummary title="Fix the following:" items={sameMessage} />,
    );
    const companyLink = container.querySelector('a[href="#company_name"]');
    const planLink = container.querySelector('a[href="#plan_id"]');
    expect(companyLink).not.toBeNull();
    expect(planLink).not.toBeNull();
    // Same underlying zod message on both — the rendered TEXT must still
    // differ, because each line names its own field.
    expect(companyLink?.textContent).not.toBe(planLink?.textContent);
    expect(companyLink).toHaveTextContent('Company name');
    expect(companyLink).toHaveTextContent('This field is required.');
    expect(planLink).toHaveTextContent('Plan');
    expect(planLink).toHaveTextContent('This field is required.');
  });
});
