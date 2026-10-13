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
  it('renders the current q value in the search input', () => {
    renderForm('all', '42');
    expect(screen.getByRole('searchbox', { name: /search by member number/i })).toHaveValue('42');
  });

  // Spec 122 US10b (maintainer, 13 Oct): the search looks like every other
  // list's — the FilterBar search, its name read out but not shown above the
  // box, the hint inside it, and no Search button.
  it('is the FilterBar search like every other list, with no visible label', () => {
    const { container } = renderForm();
    const input = screen.getByRole('searchbox', { name: /search by member number/i });
    expect(input.closest('.aura-filterbar')).not.toBeNull();
    expect(input).toHaveAttribute('placeholder', 'e.g. SCCM-0042');
    expect(container.querySelector('label:not(.sr-only)')).toBeNull();
  });

  it('has no Search button: it searches as you type (maintainer, 13 Oct)', () => {
    renderForm();
    expect(screen.queryByRole('button', { name: /^search$/i })).toBeNull();
  });

  it('after a pause in typing, replaces the URL with q (trimmed) and keeps the status', () => {
    renderForm('overdue');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' SCCM-0017 ' } });
    expect(replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(350));
    expect(replace).toHaveBeenLastCalledWith('/admin/compliance/erasure-log?status=overdue&q=SCCM-0017', { scroll: false });
  });

  it('emptying the box drops q (and a status of "all" adds nothing)', () => {
    renderForm('all', '42');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    act(() => vi.advanceTimersByTime(350));
    expect(replace).toHaveBeenLastCalledWith('/admin/compliance/erasure-log', { scroll: false });
  });

  it('Enter searches at once, without waiting for the pause', () => {
    renderForm();
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: '17' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(replace).toHaveBeenLastCalledWith('/admin/compliance/erasure-log?q=17', { scroll: false });
  });

  // R43: the bar's region must not repeat the search's name, or a screen
  // reader hears it twice and getByLabel finds two elements.
  it('names the search once: the bar region keeps its own name', () => {
    renderForm();
    expect(screen.getAllByLabelText(/search by member number/i)).toHaveLength(1);
  });
});
