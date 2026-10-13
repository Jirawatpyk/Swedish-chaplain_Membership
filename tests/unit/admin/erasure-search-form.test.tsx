import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ErasureSearchForm } from '@/app/(staff)/admin/compliance/erasure-log/_components/erasure-search-form';

function renderForm(status = 'all', q = '') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ErasureSearchForm status={status} q={q} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('ErasureSearchForm', () => {
  it('is a GET form with a member-number input and a hidden status field', () => {
    const { container } = renderForm('overdue');
    const form = container.querySelector('form')!;
    expect(form.getAttribute('method')?.toLowerCase()).toBe('get');
    expect(form.getAttribute('action')).toBe('/admin/compliance/erasure-log');
    expect(screen.getByLabelText(/search by member number/i)).toHaveAttribute('name', 'q');
    expect(container.querySelector('input[type="hidden"][name="status"]')).toHaveAttribute('value', 'overdue');
  });

  it('omits the hidden status field when status is "all"', () => {
    const { container } = renderForm('all');
    expect(container.querySelector('input[type="hidden"][name="status"]')).not.toBeInTheDocument();
  });

  it('renders the current q value in the search input', () => {
    renderForm('all', '42');
    expect(screen.getByLabelText(/search by member number/i)).toHaveValue('42');
  });

  it('shows a clear-search link only when q is non-empty', () => {
    renderForm('all', '42');
    expect(screen.getByRole('link', { name: /clear search/i })).toBeInTheDocument();
  });

  it('gives the clear-search link a 44px box on phones (UX review L1)', () => {
    renderForm('all', '42');
    expect(screen.getByRole('link', { name: /clear search/i })).toHaveClass('max-sm:min-h-11');
  });

  it('hides the clear-search link when q is empty', () => {
    renderForm('all', '');
    expect(screen.queryByRole('link', { name: /clear search/i })).not.toBeInTheDocument();
  });

  // Spec 122 US10b (T1015; board `Admin-erasure-log`): an AURA field with the
  // board's visible label, and an AURA submit button.
  it('is an AURA field with a visible label and an AURA Search button', () => {
    const { container } = renderForm();
    const input = screen.getByLabelText(/search by member number/i);
    expect(input.closest('.aura-field')).not.toBeNull();
    const label = container.querySelector(`label[for="${input.id}"]`)!;
    expect(label).not.toHaveClass('sr-only');
    expect(screen.getByRole('button', { name: /^search$/i })).toHaveClass('aura-btn');
  });

  it('the Search button is text only, as board Admin-erasure-log draws it (maintainer, parity comment 13 Oct)', () => {
    renderForm();
    expect(screen.getByRole('button', { name: /^search$/i }).querySelector('svg')).toBeNull();
  });
});

