// @vitest-environment jsdom
/**
 * `/admin/settings/broadcasts` — the allowlist editor read `body.error` as a
 * string code, but a hostname that fails the route's zod parse answers
 * `errorResponse(400, 'invalid_body', …)`, whose `error` is an OBJECT
 * `{ code, message, messageThai, fieldErrors }`. The lookup built
 * `errors.[object Object]` and every format refusal (uppercase, wildcard,
 * no dot) toasted "Unknown error." — as did the 500 `internal_error`.
 *
 * The fake server below answers with the route's REAL envelope
 * (`errorResponse` + the Domain `HOSTNAME_REGEX` the route validates with),
 * so the test cannot drift from what the route actually sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from 'sonner';
import { errorResponse } from '@/lib/broadcasts-route-helpers';
import { HOSTNAME_REGEX } from '@/modules/broadcasts/domain/value-objects/image-source-allowlist';
import { AdminImageAllowlistEditor } from '@/components/broadcast/admin-image-allowlist-editor';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const tErrors = enMessages.admin.broadcasts.settings.allowlist.errors;

/** The route's parse step: 400 `invalid_body` with fieldErrors, else 200. */
async function fakeAllowlistRoute(_url: string, init: RequestInit): Promise<Response> {
  const { hostname } = JSON.parse(String(init.body)) as { hostname: string };
  if (!HOSTNAME_REGEX.test(hostname)) {
    return errorResponse(400, 'invalid_body', 'corr-1', {
      fieldErrors: { hostname: ['invalid_hostname'] },
    });
  }
  return Response.json({
    allowlist: [
      { hostname: 'cdn.example.org', isDefault: true },
      { hostname, isDefault: false },
    ],
  });
}

function renderEditor() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AdminImageAllowlistEditor initial={[{ hostname: 'cdn.example.org', isDefault: true }]} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  // userEvent schedules its inter-key delay on the shared setup's FAKE timers.
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('allowlist editor — the route’s object-shaped error envelope', () => {
  it('an uppercase wildcard hostname shows "Invalid hostname format." inline on the field', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(fakeAllowlistRoute);
    vi.stubGlobal('fetch', fetchMock);
    renderEditor();

    const input = screen.getByLabelText(/hostname/i);
    await user.type(input, '*.Images.Example.org');
    await user.click(screen.getByRole('button', { name: /add/i }));

    const inline = await screen.findByText(tErrors.invalid_hostname);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(inline.id);
    expect(toast.error).toHaveBeenCalledWith(tErrors.invalid_hostname);
    expect(toast.error).not.toHaveBeenCalledWith(tErrors.unknown);

    // Editing the field clears the stale error.
    await user.type(input, 'x');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(tErrors.invalid_hostname)).toBeNull();
  });

  it('lowercases the hostname before sending, so "Images.Example.ORG" is accepted', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(fakeAllowlistRoute);
    vi.stubGlobal('fetch', fetchMock);
    renderEditor();

    await user.type(screen.getByLabelText(/hostname/i), 'Images.Example.ORG');
    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { hostname: string };
    expect(sent.hostname).toBe('images.example.org');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a 500 internal_error shows its own message, not "Unknown error."', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => errorResponse(500, 'internal_error', 'corr-2')),
    );
    renderEditor();

    await user.type(screen.getByLabelText(/hostname/i), 'images.example.org');
    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(tErrors.internal_error));
    expect(screen.getByLabelText(/hostname/i)).not.toHaveAttribute('aria-invalid', 'true');
  });
});
