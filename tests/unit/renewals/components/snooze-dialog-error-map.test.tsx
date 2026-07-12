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
 * The Base UI Dialog primitives are replaced with passthrough divs so the
 * Confirm button is reachable without jsdom Base UI transition flakiness.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), info: vi.fn() },
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
