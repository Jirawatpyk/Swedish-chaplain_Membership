/**
 * PR B (#707 follow-up) — `<ReplyToForm>` on `/admin/settings/renewals/reply-to`.
 *
 * Pinned: the stored values prefill the fields; Save sends
 * `PUT /api/admin/renewals/settings/reply-to` (blank → null); a toast only
 * when the server says something changed; a 422 shows on its field and keeps
 * what was typed; a read-only 503 and a 500 show inline; Remove sends nulls
 * and is offered only while a value is stored; the role-mailbox hint shows.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from '@/lib/toast';
import en from '@/i18n/messages/en.json';
import { ReplyToForm } from '@/app/(staff)/admin/settings/renewals/reply-to/_components/reply-to-form';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const t = en.admin.settings.renewalReplyTo;

function renderForm(email: string | null = null, displayName: string | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ReplyToForm initialEmail={email} initialDisplayName={displayName} />
    </NextIntlClientProvider>,
  );
}

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const emailInput = () => screen.getByLabelText(t.email.label) as HTMLInputElement;
const nameInput = () => screen.getByLabelText(new RegExp(`^${t.displayName.label}`)) as HTMLInputElement;

// tests/setup.ts installs fake timers globally; the fetch round trips and
// waitFor here need real ones.
beforeAll(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ReplyToForm', () => {
  it('prefills the stored values and shows the role-mailbox hint and the note', () => {
    renderForm('membership@swecham.example', 'SweCham');
    expect(emailInput().value).toBe('membership@swecham.example');
    expect(nameInput().value).toBe('SweCham');
    expect(screen.getByText(t.email.hint)).toBeTruthy();
    expect(screen.getByText(t.note)).toBeTruthy();
  });

  it('Save sends the values (blank name as null) and toasts when changed', async () => {
    const fetchFn = stubFetch(200, { email: 'm@swecham.example', displayName: null, changed: true });
    renderForm();
    fireEvent.change(emailInput(), { target: { value: 'm@swecham.example' } });
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(t.toast.saved));
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/admin/renewals/settings/reply-to');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'm@swecham.example', displayName: null });
    expect(emailInput().value).toBe('m@swecham.example');
    expect(screen.getByRole('button', { name: t.actions.remove })).toBeTruthy();
  });

  it('an unchanged save shows no toast and says so inline', async () => {
    stubFetch(200, { email: 'm@swecham.example', displayName: null, changed: false });
    renderForm('m@swecham.example');
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(t.status.unchanged));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a name over 100 characters is refused before sending', async () => {
    const fetchFn = stubFetch(200, {});
    renderForm('m@swecham.example');
    fireEvent.change(nameInput(), { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    expect(await screen.findByText(t.errors.nameTooLong)).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a network failure says the server was not reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    renderForm('m@swecham.example');
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.network);
  });

  it('a 422 invalid_email shows on the email field and keeps the typed value', async () => {
    stubFetch(422, { error: { code: 'invalid_email' } });
    renderForm();
    fireEvent.change(emailInput(), { target: { value: 'not an address' } });
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    expect(await screen.findByText(t.errors.invalidEmail)).toBeTruthy();
    expect(emailInput().value).toBe('not an address');
    expect(emailInput().getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(emailInput()));
  });

  it('a 422 invalid_display_name shows its reason on the name field', async () => {
    stubFetch(422, { error: { code: 'invalid_display_name', reason: 'unsafe_character' } });
    renderForm('m@swecham.example');
    fireEvent.change(nameInput(), { target: { value: 'Jane <x@y>' } });
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    expect(await screen.findByText(t.errors.nameUnsafe)).toBeTruthy();
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(nameInput()));
  });

  it('a read-only 503 and a 500 show inline alerts; nothing toasts', async () => {
    stubFetch(503, { error: 'read-only-mode' });
    renderForm('m@swecham.example');
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.errors.readOnly);
    stubFetch(500, { error: { code: 'server_error' } });
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(t.errors.generic));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("the toast's Undo sends nothing while another save is in flight", async () => {
    const fetchFn = stubFetch(200, { email: null, displayName: null, changed: true });
    renderForm('m@swecham.example', 'SweCham');
    fireEvent.click(screen.getByRole('button', { name: t.actions.remove }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const undo = (vi.mocked(toast.success).mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1].action;
    fetchFn.mockImplementationOnce(() => new Promise<Response>(() => {}));
    fireEvent.change(emailInput(), { target: { value: 'n@swecham.example' } });
    fireEvent.click(screen.getByRole('button', { name: t.actions.save }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    undo.onClick();
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('Remove is offered only while a value is stored, and sends nulls', async () => {
    renderForm();
    expect(screen.queryByRole('button', { name: t.actions.remove })).toBeNull();
    cleanup();
    const fetchFn = stubFetch(200, { email: null, displayName: null, changed: true });
    renderForm('m@swecham.example', 'SweCham');
    fireEvent.click(screen.getByRole('button', { name: t.actions.remove }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const [message, opts] = vi.mocked(toast.success).mock.calls[0] as unknown as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe(t.toast.removed);
    expect(opts.action.label).toBe(t.toast.undo);
    expect(JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ email: null, displayName: null });
    expect(emailInput().value).toBe('');
    expect(screen.queryByRole('button', { name: t.actions.remove })).toBeNull();
    // The Remove button is gone, so focus moves to the email field, not <body>.
    await waitFor(() => expect(document.activeElement).toBe(emailInput()));

    // Undo puts the removed values back.
    fetchFn.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ email: 'm@swecham.example', displayName: 'SweCham', changed: true }), { status: 200 }),
    );
    opts.action.onClick();
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({
      email: 'm@swecham.example',
      displayName: 'SweCham',
    });
    await waitFor(() => expect(emailInput().value).toBe('m@swecham.example'));
  });
});
