/**
 * `ContactLanguageForm` (round 7, tests N2): a failed save REVERTS the radio to
 * the last value the server accepted (the radio must never disagree with the
 * record), a 503 names the write freeze, and a success moves the saved value.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ContactLanguageForm } from '@/components/portal/contact-language-form';

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/lib/toast', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn() } }));

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContactLanguageForm initialValue="en" />
    </NextIntlClientProvider>,
  );
}

function pick(value: string) {
  // AURA RadioGroup: native radios named by their label
  fireEvent.click(screen.getByRole('radio', { name: enMessages.common.languageOptions[value as 'th' | 'sv' | 'en'] }));
}

const checked = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLInputElement;

describe('ContactLanguageForm', () => {
  it('a 503 (the write freeze) reverts the radio to the saved value and names the freeze', async () => {
    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"read_only_mode"}', { status: 503, headers: { 'content-type': 'application/json' } })));
    try {
      renderForm();
      pick('th');
      expect(checked(/thai|ไทย/i)).toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: enMessages.portal.account.contactLanguage.save }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(enMessages.portal.account.contactLanguage.readOnlyToast));
      await waitFor(() => expect(checked(/english/i)).toBeChecked());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a 200 keeps the new value as the saved one (a later failure reverts to IT, not to the initial value)', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderForm();
      pick('sv');
      fireEvent.click(screen.getByRole('button', { name: enMessages.portal.account.contactLanguage.save }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(enMessages.portal.account.contactLanguage.savedToast));
      fetchMock.mockImplementationOnce(async () => new Response('{"error":"server_error"}', { status: 500, headers: { 'content-type': 'application/json' } }));
      pick('th');
      fireEvent.click(screen.getByRole('button', { name: enMessages.portal.account.contactLanguage.save }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(enMessages.portal.account.contactLanguage.errorToast));
      await waitFor(() => expect(checked(/svenska|swedish/i)).toBeChecked());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ContactLanguageForm on AURA (spec 122 US3)', () => {
  it('is an AURA radio group named by the form title, with Save in an ActionBar that says when the choice is unsaved', () => {
    renderForm();
    const group = screen.getByRole('group', { name: enMessages.portal.account.contactLanguage.title });
    expect(group).toHaveClass('aura-radio-group');
    const bar = screen.getByRole('region', { name: 'Actions' });
    expect(bar).toContainElement(screen.getByRole('button', { name: enMessages.portal.account.contactLanguage.save }));
    const status = bar.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('');
    pick('th');
    expect(status.textContent).toBe(enMessages.common.unsavedStatus);
  });
});
