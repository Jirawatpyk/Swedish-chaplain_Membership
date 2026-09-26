/**
 * PortalEditForm — server field rejection surfaced inline (audit XF-01).
 *
 * A 400 validation_error whose issue path tail matches a form field must be
 * mapped back onto that field (setError + focus), not just toasted. Rendered
 * against real en.json with a mocked fetch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { PortalEditForm } from '@/components/members/portal-edit-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), info: vi.fn() },
}));

beforeEach(() => {
  vi.useRealTimers();
  toastError.mockClear();
});

const INITIAL = {
  firstName: 'Jane',
  lastName: 'Doe',
  phone: '',
  website: '',
  description: '',
};

describe('PortalEditForm — inline server field error', () => {
  it('maps a 400 validation_error onto the website field instead of a toast', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          code: 'validation_error',
          // Server messages can be raw dev tokens (e.g. "invalid phone: <code>");
          // the form must NOT render them verbatim.
          details: [{ path: ['website'], message: 'invalid website: bad_scheme' }],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PortalEditForm initialValues={INITIAL} />
      </NextIntlClientProvider>,
    );

    // Change a field so the PATCH actually fires (the form skips on no-change).
    fireEvent.change(container.querySelector('#firstName')!, {
      target: { value: 'Janet' },
    });
    fireEvent.submit(container.querySelector('form')!);

    // The website rejection renders inline (role=alert) on the field, not as a
    // toast — with a LOCALISED message, never the raw server token.
    await waitFor(() =>
      expect(
        container.querySelector('#website')?.getAttribute('aria-invalid'),
      ).toBe('true'),
    );
    expect(container.querySelector('#website-error')).not.toBeNull();
    // The raw server token must not reach the user.
    expect(screen.queryByText('invalid website: bad_scheme')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('maps a 403 forbidden CODE to localized copy, never the raw server message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: 'forbidden',
          // The use-case's raw reason — must NOT be toasted verbatim.
          message: 'member self-update forbidden: field_not_whitelisted',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PortalEditForm initialValues={INITIAL} />
      </NextIntlClientProvider>,
    );

    fireEvent.change(container.querySelector('#firstName')!, {
      target: { value: 'Janet' },
    });
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const arg = toastError.mock.calls[0]?.[0] as string;
    expect(arg).toBe("You don't have permission to edit this profile.");
    // The raw server message must never reach the user.
    expect(arg).not.toContain('field_not_whitelisted');

    vi.unstubAllGlobals();
  });
});

describe('PortalEditForm on AURA (spec 122 US3)', () => {
  function renderForm() {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PortalEditForm initialValues={INITIAL} />
      </NextIntlClientProvider>,
    );
  }

  it('uses AURA fields and keeps Save in an ActionBar that says when changes are unsaved', () => {
    const { container } = renderForm();
    for (const id of ['firstName', 'lastName', 'phone', 'website']) {
      expect(container.querySelector(`#${id}`)?.closest('.aura-field')).not.toBeNull();
    }
    expect(container.querySelector('#description')).toHaveClass('aura-textarea');
    const bar = screen.getByRole('region', { name: 'Actions' });
    expect(bar).toHaveClass('aura-actionbar');
    expect(bar).toContainElement(screen.getByRole('button', { name: enMessages.portal.edit.saveButton }));
    const status = bar.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('');
    fireEvent.change(container.querySelector('#firstName')!, { target: { value: 'Janet' } });
    expect(status.textContent).toBe(enMessages.common.unsavedStatus);
  });

  it('lists a failed submit in a focused error summary that links to the field', async () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('#firstName')!, { target: { value: '' } });
    fireEvent.submit(container.querySelector('form')!);
    const summary = await screen.findByRole('alert', { name: /fix 1 field/i });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(summary.querySelector('a')).toHaveAttribute('href', '#firstName');
  });
});
