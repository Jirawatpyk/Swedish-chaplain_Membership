/**
 * Spec 122 US3 — the immediate-save profile form (approval mode off) follows
 * the 27 Sep decisions like every other portal form: sentence-case copy, and
 * Cancel / Save as plain buttons at the end of the last card rather than a
 * sticky ActionBar, with the browser's unsaved-changes prompt armed while the
 * form is dirty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PortalEditForm } from '@/components/members/portal-edit-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const INITIAL = { firstName: 'Jane', lastName: 'Doe', phone: '', website: '', description: '' };

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalEditForm initialValues={INITIAL} />
    </NextIntlClientProvider>,
  );
}

describe('PortalEditForm — layout and copy (spec 122 decisions 1 and 2)', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(cleanup);

  it('uses sentence case', () => {
    renderForm();
    expect(screen.getByRole('heading', { name: 'Your contact details' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Company details' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^First name/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('ends the last card with Cancel then Save, with no action bar', () => {
    const { container } = renderForm();
    const save = screen.getByRole('button', { name: 'Save changes' });
    const actions = save.closest('[data-slot="form-actions"]');
    expect(actions).not.toBeNull();
    expect(Array.from(actions!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Cancel', 'Save changes']);
    expect(container.querySelector('.aura-actionbar')).toBeNull();
    expect(actions!.closest('.aura-card')).toBe(container.querySelectorAll('.aura-card')[1]);
  });

  it('arms the unsaved-changes prompt once a field changes', () => {
    const { container } = renderForm();
    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    fireEvent.change(container.querySelector('#firstName')!, { target: { value: 'Janet' } });
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
  });
});
