/**
 * Spec 122 US9c (T944) — "Send test event" on AURA `Button` (board
 * `Admin-eventcreate`: secondary, no icon; while it runs AURA's loading
 * spinner and the same "Sending test event…" text).
 *
 * Unchanged (FR-011): one click sends one POST to the test-webhook route,
 * and the button stays busy through the 2-second cooldown so a second click
 * sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { TestWebhookButton } = await import('@/components/events/test-webhook-button');

const c = en.admin.integrations.eventcreate.phaseC.test;

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderButton() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TestWebhookButton />
    </NextIntlClientProvider>,
  );
}

describe('<TestWebhookButton> on AURA', () => {
  it('is the board\'s plain "Send test event" button, with no icon while idle', () => {
    renderButton();
    const button = screen.getByRole('button', { name: c.sendTest });
    expect(button).toBeEnabled();
    expect(button.querySelector('svg')).toBeNull();
  });

  it('sends one request per click and nothing during the cooldown', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, processingOutcome: 'short_circuited_test', durationMs: 42 }),
    } as Response);
    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: c.sendTest }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/admin/integrations/eventcreate/test-webhook');
    const busy = screen.getByRole('button', { name: c.inProgress });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    // Busy, not disabled: focus stays on the button through the request
    // and the cooldown, and AURA's loading swallows the clicks.
    expect(busy).not.toBeDisabled();
    fireEvent.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole('button', { name: c.sendTest })).toBeEnabled();
  });
});
