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

  it('shows a clear-search link only when q is non-empty', () => {
    const { rerender } = renderForm('all', '42');
    expect(screen.getByRole('link', { name: /clear search/i })).toBeInTheDocument();
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ErasureSearchForm status="all" q="" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('link', { name: /clear search/i })).not.toBeInTheDocument();
  });
});
