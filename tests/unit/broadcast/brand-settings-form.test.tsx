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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';
import { BrandSettingsForm } from '@/components/broadcast/brand/brand-settings-form';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// U27 (portal live walk) — the form renders `<UnsavedChangesGuard>`, which
// `router.push`es a confirmed in-app navigation. jsdom has no app router.
const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

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
    // ≈ 9.417 raw — the readout FLOORS (never claims more than the raw ratio).
    expect(screen.getByTestId('brand-contrast-readout')).toHaveTextContent('9.41');
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

  // #0080aa is ≈ 4.4986:1 raw — below AA, so the API refuses it. Its ROUNDED
  // ratio is 4.5, which is how a Save gated on the display value used to
  // enable and then earn a 422 "{ ratio: 4.5, required: 4.5 }".
  it('typing `#0080aa` (just under AA) keeps Save disabled', async () => {
    const user = userEvent.setup();
    renderForm();
    const field = screen.getByLabelText(/primary colour/i);
    await user.clear(field);
    await user.type(field, '#0080aa');

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

// ── T155 § 15 findings on this screen ──────────────────────────────────────

/**
 * U19 — § 15 item 11. The screen was a `<div>` with a `type="button"` Save, so
 * Enter in the colour field did nothing. That is defensible on the two compose
 * surfaces (a rich-text body owns Enter); it is not defensible on two plain
 * fields and a Save.
 *
 * The address TEXTAREA deliberately keeps Enter for a newline — FR-041c makes
 * the postal address multi-line — which is the native behaviour of a textarea
 * inside a form and needs no exception.
 */
describe('BrandSettingsForm — U19: it is a real form', () => {
  it('the fields sit in a <form> whose Save is the submit button', () => {
    const { container } = renderForm();
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(saveButton().type).toBe('submit');
    expect(form!.contains(saveButton())).toBe(true);
    expect(form!.contains(screen.getByLabelText(/primary colour/i))).toBe(true);
    expect(form!.contains(screen.getByLabelText(/postal address/i))).toBe(true);
  });

  it('submitting the form PATCHes — the implicit-submission path Enter uses', async () => {
    const fetchMock = stubFetch({ status: 200, body: BASE });
    const { container } = renderForm();

    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('PATCH');
  });
});

/**
 * U17 — Save disables below AA with the reason ~200 px away in another card
 * and nothing linking the two. A keyboard user hears "Save, dimmed" and
 * nothing else (WCAG 3.3.2).
 */
describe('BrandSettingsForm — U17: a disabled Save says why', () => {
  it('below AA, Save is described by the visible contrast readout', async () => {
    const user = userEvent.setup();
    renderForm();
    const field = screen.getByLabelText(/primary colour/i);
    await user.clear(field);
    await user.type(field, '#f5f5f5');

    const save = saveButton();
    expect(save).toBeDisabled();
    const describedBy = save.getAttribute('aria-describedby');
    expect(describedBy, 'the dimmed Save must name its reason').toBeTruthy();
    const reason = document.getElementById(describedBy!.split(/\s+/)[0]!);
    expect(reason).not.toBeNull();
    expect(reason).toBe(screen.getByTestId('brand-contrast-readout'));
  });

  it('an over-long address adds ITS reason to the same list', () => {
    renderForm({ postalAddress: 'x'.repeat(301) });
    const save = saveButton();
    expect(save).toBeDisabled();
    const ids = (save.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    const texts = ids.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(texts.join(' ')).toMatch(/300/);
  });

  it('when Save is enabled it is described by nothing — no phantom reason', () => {
    renderForm();
    expect(saveButton()).not.toBeDisabled();
    expect(saveButton().getAttribute('aria-describedby')).toBeNull();
  });
});

/**
 * U18 — both compose surfaces ship `useComposeDirtyGuard`; Brand shipped no
 * guard at all, so a colour edited and abandoned was lost silently. Verified
 * live 2026-09-22: leaving compose fires `beforeunload`, leaving Brand did not.
 */
describe('BrandSettingsForm — U18: unsaved changes are guarded', () => {
  const fireBeforeUnload = (): boolean => {
    const evt = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evt);
    return evt.defaultPrevented;
  };

  it('an untouched form does not warn', () => {
    renderForm();
    expect(fireBeforeUnload()).toBe(false);
  });

  it('editing the colour arms the warning', async () => {
    const user = userEvent.setup();
    renderForm();
    const field = screen.getByLabelText(/primary colour/i);
    await user.clear(field);
    await user.type(field, '#0b5f3a');
    expect(fireBeforeUnload()).toBe(true);
  });

  it('after a successful Save the warning is disarmed', async () => {
    const user = userEvent.setup();
    stubFetch({ status: 200, body: { ...BASE, primaryColor: '#0b5f3a' } });
    renderForm();
    const field = screen.getByLabelText(/primary colour/i);
    await user.clear(field);
    await user.type(field, '#0b5f3a');
    expect(fireBeforeUnload()).toBe(true);

    await user.click(saveButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(fireBeforeUnload()).toBe(false);
  });

  it('with an edit pending, the in-app "Manage the logo" link asks before leaving', async () => {
    // `beforeunload` never fires for an in-app `<Link>`, and this one sits in
    // the form itself.
    const user = userEvent.setup();
    pushMock.mockClear();
    renderForm();
    const field = screen.getByLabelText(/primary colour/i);
    await user.clear(field);
    await user.type(field, '#0b5f3a');

    fireEvent.click(screen.getByRole('link', { name: 'Manage the logo' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

/**
 * U16, revised by the F119 UX review — the logo swatch shows the logo the way
 * the E-Blast shows it: on WHITE, because every mail client composites the
 * email on white. The first fix used a THEMED checker (`bg-card` + the
 * `--color-muted` token), and in dark mode a dark logo vanished into it. The
 * backing is now a fixed light checker in both themes.
 */
describe('BrandSettingsForm — U16: the logo swatch uses the email light backing', () => {
  it('sits on a fixed light checker, not a theme token', () => {
    renderForm();
    const backing = screen.getByTestId('brand-logo-preview');
    expect(backing.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(backing.style.backgroundImage).toMatch(/gradient/);
    // A theme variable here is what made dark logos disappear in dark mode.
    expect(backing.style.backgroundImage).not.toContain('var(');
    expect(backing.className).not.toMatch(/\bbg-card\b/);
  });
});
