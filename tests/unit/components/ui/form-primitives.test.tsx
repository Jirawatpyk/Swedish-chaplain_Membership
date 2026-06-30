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
    { fieldId: 'company_name', message: 'Company name is required' },
    { fieldId: 'tax_id', message: 'Tax ID is invalid' },
  ];

  it('renders nothing when there are no errors', () => {
    const { container } = render(
      <FormErrorSummary title="Fix the following:" items={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a role=alert region with one jump link per error', () => {
    const { getByRole, getByText } = render(
      <FormErrorSummary title="Fix the following:" items={items} />,
    );
    const region = getByRole('alert');
    expect(region.getAttribute('tabindex')).toBe('-1');
    const link = getByText('Tax ID is invalid');
    expect(link.getAttribute('href')).toBe('#tax_id');
  });

  it('takes focus when the error set appears (delivers keyboard/SR users to it)', () => {
    const { getByRole } = render(
      <FormErrorSummary title="Fix the following:" items={items} />,
    );
    expect(document.activeElement).toBe(getByRole('alert'));
  });
});
