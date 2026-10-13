import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }) }));

import { ErasureSearchForm } from '@/app/(staff)/admin/compliance/erasure-log/_components/erasure-search-form';

function renderForm(status = 'all', q = '') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ErasureSearchForm status={status} q={q} />
    </NextIntlClientProvider>,
  );
}
beforeEach(() => {
  replace.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
  // board's visible label (no Search button, maintainer 13 Oct).
  it('is an AURA field with a visible label', () => {
    const { container } = renderForm();
    const input = screen.getByLabelText(/search by member number/i);
    expect(input.closest('.aura-field')).not.toBeNull();
    const label = container.querySelector(`label[for="${input.id}"]`)!;
    expect(label).not.toHaveClass('sr-only');
  });

  it('has no Search button: it searches as you type, like every other list (maintainer, 13 Oct)', () => {
    renderForm();
    expect(screen.queryByRole('button', { name: /^search$/i })).toBeNull();
  });

  it('after a pause in typing, replaces the URL with q (trimmed) and keeps the status', () => {
    renderForm('overdue');
    fireEvent.change(screen.getByLabelText(/search by member number/i), { target: { value: ' SCCM-0017 ' } });
    expect(replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(350));
    expect(replace).toHaveBeenLastCalledWith('/admin/compliance/erasure-log?status=overdue&q=SCCM-0017', { scroll: false });
  });

  it('emptying the box drops q (and a status of "all" adds nothing)', () => {
    renderForm('all', '42');
    fireEvent.change(screen.getByLabelText(/search by member number/i), { target: { value: '' } });
    act(() => vi.advanceTimersByTime(350));
    expect(replace).toHaveBeenLastCalledWith('/admin/compliance/erasure-log', { scroll: false });
  });

  it('Enter searches at once, without waiting for the pause', () => {
    const { container } = renderForm();
    fireEvent.change(screen.getByLabelText(/search by member number/i), { target: { value: '17' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(replace).toHaveBeenLastCalledWith('/admin/compliance/erasure-log?q=17', { scroll: false });
  });
});

