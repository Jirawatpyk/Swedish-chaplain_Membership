/**
 * F119 T030 — `<BrandSettingsForm />` (FR-041b/c).
 *
 * The one behaviour that must never be a surprise: a colour whose contrast
 * with white text is below WCAG AA 4.5:1 is refused by the API, so the form
 * says so live and disables Save BEFORE the round-trip. The readout is
 * computed from the SAME arithmetic the Domain refuses with
 * (`contrastRatioOnWhite`), reached through the client-safe re-export.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json` — a dangling
 * `t()` reference therefore fails here rather than shipping a raw key path
 * (next-intl does not throw on a missing key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { BrandSettingsForm } from '@/components/broadcast/brand/brand-settings-form';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** A `fetch` double returning one scripted Response-shaped object. */
function stubFetch(init: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): ReturnType<typeof vi.fn> {
  const headers = new Headers(init.headers ?? {});
  const fn = vi.fn().mockResolvedValue({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers,
    json: async () => init.body ?? {},
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

type View = React.ComponentProps<typeof BrandSettingsForm>['initial'];

const BASE: View = {
  primaryColor: '#10487a',
  postalAddress: '349 Sukhumvit Road, Bangkok 10110',
  addressMissing: false,
  logo: {
    url: 'https://cdn.test/logo.png',
    source: 'invoice_settings',
    manageHref: '/admin/settings/invoicing',
  },
  defaults: { primaryColor: '#10487a' },
  updatedAt: '2026-09-18T00:00:00.000Z',
};

function renderForm(overrides: Partial<View> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrandSettingsForm initial={{ ...BASE, ...overrides }} />
    </NextIntlClientProvider>,
  );
}

const saveButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;

// The shared setup installs FAKE timers; `userEvent` schedules its inter-key
// delay on them, so without this every typing case dies on the 30 s test
// timeout with no error pointing at timers.
beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BrandSettingsForm — live contrast readout', () => {
  it('the stored navy shows a passing ratio and Save is enabled', () => {
    renderForm();
    expect(screen.getByTestId('brand-contrast-readout')).toHaveTextContent('9.42');
    expect(saveButton()).not.toBeDisabled();
  });

  it('typing `#f5f5f5` shows the ratio and disables Save', async () => {
    const user = userEvent.setup();
    renderForm();
    const field = screen.getByLabelText(/primary colour/i);
    await user.clear(field);
    await user.type(field, '#f5f5f5');

    const readout = screen.getByTestId('brand-contrast-readout');
    // The measured ratio, and the AA threshold the refusal names.
    expect(readout).toHaveTextContent('1.09');
    expect(readout).toHaveTextContent('4.5');
    expect(saveButton()).toBeDisabled();
  });

  it('an incomplete hex is not reported as a contrast failure', async () => {
    const user = userEvent.setup();
    renderForm();
    const field = screen.getByLabelText(/primary colour/i);
    await user.clear(field);
    await user.type(field, '#10487');
    // Half-typed is a FORMAT problem, not a contrast one — claiming a ratio
    // for a colour that does not parse would be a fabricated number.
    expect(screen.queryByTestId('brand-contrast-readout')).toBeNull();
    expect(saveButton()).toBeDisabled();
  });
});

describe('BrandSettingsForm — postal address', () => {
  it('counts the characters against the 300 bound', () => {
    renderForm({ postalAddress: 'abc' });
    expect(screen.getByTestId('brand-address-counter')).toHaveTextContent('3');
    expect(screen.getByTestId('brand-address-counter')).toHaveTextContent('300');
  });

  it('an empty address shows an inline NOTICE, not a field error', () => {
    renderForm({ postalAddress: null, addressMissing: true });
    const notice = screen.getByTestId('brand-address-missing');
    expect(notice).toBeInTheDocument();
    // A missing address does not block the save — it is a state of the world,
    // not an invalid entry.
    expect(saveButton()).not.toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps line breaks in the address field (multi-line, FR-041c)', () => {
    renderForm({ postalAddress: 'Line 1\nLine 2' });
    const field = screen.getByLabelText(/postal address/i);
    expect(field.tagName).toBe('TEXTAREA');
    expect((field as HTMLTextAreaElement).value).toBe('Line 1\nLine 2');
  });
});

describe('BrandSettingsForm — the logo is read-only', () => {
  it('shows its source and a Manage link for a settings.invoicing holder', () => {
    renderForm();
    expect(screen.getByText(/from invoice settings/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /manage/i });
    expect(link).toHaveAttribute('href', '/admin/settings/invoicing');
  });

  it('manageHref null → the hint tells the user to ask an administrator, with no link', () => {
    renderForm({
      logo: { url: 'https://cdn.test/logo.png', source: 'invoice_settings', manageHref: null },
    });
    expect(screen.getByText(/ask an administrator/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /manage/i })).toBeNull();
  });

  it('offers no upload control — the logo is not writable from here (FR-041b)', () => {
    renderForm();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('BrandSettingsForm — saving', () => {
  it('PATCHes colour + address, and sends NO logo key (the schema is strict)', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch({ status: 200, body: { ...BASE, primaryColor: '#0b5f3a' } });
    renderForm();
    await user.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/broadcasts/brand');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      primaryColor: '#10487a',
      postalAddress: '349 Sukhumvit Road, Bangkok 10110',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('422 colour_contrast → the SERVER ratio is shown inline, not ours', async () => {
    const user = userEvent.setup();
    stubFetch({
      status: 422,
      body: { error: { code: 'colour_contrast', details: { ratio: 3.1, required: 4.5 } } },
    });
    renderForm();
    await user.click(saveButton());

    const inline = await screen.findByTestId('brand-contrast-server-error');
    // 3.1 is the server's number for a colour the client measured at 9.42 —
    // a divergence the reader has to be able to see, so the client must not
    // substitute its own.
    expect(inline).toHaveTextContent('3.1');
    expect(inline).toHaveTextContent('4.5');
    expect(inline).not.toHaveTextContent('9.42');
  });

  it('429 → the toast names the Retry-After seconds', async () => {
    const user = userEvent.setup();
    stubFetch({ status: 429, body: {}, headers: { 'Retry-After': '42' } });
    renderForm();
    await user.click(saveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String((toast.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('42');
  });

  it('500 → the generic failure toast, and nothing is claimed as saved', async () => {
    const user = userEvent.setup();
    stubFetch({ status: 500, body: { error: { code: 'internal_error' } } });
    renderForm();
    await user.click(saveButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByTestId('brand-contrast-server-error')).toBeNull();
  });
});
