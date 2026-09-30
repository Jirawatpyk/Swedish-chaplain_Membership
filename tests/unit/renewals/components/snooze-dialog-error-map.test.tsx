/**
 * SnoozeDialog — server error CODE mapped to localized copy (Cluster 6).
 *
 * next-intl's `t` has NO `fallback` option, so the old
 * `t(`toast.error.${code}`, { fallback })` rendered the raw dotted KEY PATH
 * for any missing key. The fix guards with `t.has(key)` and adds the missing
 * keys. This test pins:
 *   1. A newly-added code (`forbidden`) renders its localized copy.
 *   2. An unmapped code falls back to the localized `server_error` copy —
 *      never a dangling `toast.error.*` key path.
 *
 * 122 US7a (T706): the real AURA Dialog renders (no primitive mocks); the
 * duration is an AURA radio group and the chosen one is what the request
 * sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), info: vi.fn() },
}));

import { SnoozeDialog } from '@/app/(staff)/admin/renewals/_components/snooze-dialog';

beforeEach(() => {
  vi.useRealTimers();
  toastError.mockClear();
});

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SnoozeDialog open onOpenChange={vi.fn()} memberId="m-1" memberCompanyName="Acme Co" />
    </NextIntlClientProvider>,
  );
}

async function clickConfirmWith(errorCode: string, status: number) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: { code: errorCode } }),
  });
  vi.stubGlobal('fetch', fetchMock);
  renderDialog();
  screen.getByRole('button', { name: 'Confirm snooze' }).click();
  await waitFor(() => expect(toastError).toHaveBeenCalled());
  const [, opts] = toastError.mock.calls[0] as [string, { description: string }];
  vi.unstubAllGlobals();
  return opts.description;
}

describe('SnoozeDialog — server error code mapping', () => {
  it('renders localized copy for a newly-added code (forbidden), not a raw key path', async () => {
    const description = await clickConfirmWith('forbidden', 403);
    expect(description).toBe("You don't have permission to do that.");
    expect(description).not.toContain('toast.error');
  });

  it('falls back to localized server_error for an unmapped code', async () => {
    const description = await clickConfirmWith('some_unknown_code', 500);
    expect(description).toBe('Server error. Please retry.');
    // The pre-fix bug rendered the raw dotted key path — assert it does not.
    expect(description).not.toContain('toast.error');
    expect(description).not.toContain('some_unknown_code');
  });
});

describe('SnoozeDialog on AURA', () => {
  it('is an AURA alertdialog with the duration as an AURA radio fieldset, 30 days chosen', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Snooze at-risk member' });
    expect(dialog).toHaveClass('aura-dialog');
    const group = within(dialog).getByRole('group', { name: 'Duration' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['7', '30', '90']);
    expect(within(group).getByRole('radio', { name: '30 days' })).toBeChecked();
  });

  it('sends the chosen duration', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: '90 days' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm snooze' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/renewals/at-risk/m-1/snooze');
    expect(JSON.parse(init.body as string)).toEqual({ duration_days: 90 });
    vi.unstubAllGlobals();
  });
});
