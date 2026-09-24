// @vitest-environment jsdom
/**
 * Portal error states #4 — the portal error boundary says its title ONCE.
 *
 * `PortalRouteError` (used by `portal/error.tsx` and ~16 sub-route
 * boundaries) rendered `errors.generic` as the PageHeader AND as the
 * CardTitle, so a member read "Something went wrong. Please try again." twice,
 * one line apart. The approved state (AURA canvas "Portal error") keeps one
 * title, the Error ID line, Try again, and adds a way back to the dashboard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderBoundary(reset = vi.fn()): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const error = Object.assign(new Error('boom'), { digest: 'abc123' });
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalRouteError
        error={error}
        reset={reset}
        container={DetailContainer}
        logTag="[test boundary]"
      />
    </NextIntlClientProvider>,
  );
}

describe('PortalRouteError', () => {
  it('shows the title once', () => {
    renderBoundary();

    expect(screen.getAllByText(enMessages.errors.generic)).toHaveLength(1);
    expect(screen.getByRole('heading', { name: enMessages.errors.generic })).toBeInTheDocument();
  });

  it('keeps the Error ID line', () => {
    renderBoundary();

    expect(screen.getByText('Error ID: abc123')).toBeInTheDocument();
  });

  it('"Try again" calls reset', () => {
    const reset = vi.fn();
    renderBoundary(reset);

    screen.getByRole('button', { name: enMessages.buttons.retry }).click();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('offers a way back to the dashboard', () => {
    renderBoundary();

    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute(
      'href',
      '/portal',
    );
  });
});
