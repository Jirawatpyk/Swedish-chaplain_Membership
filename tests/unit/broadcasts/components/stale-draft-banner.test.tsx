/**
 * Phase 5 Round 1 R2.1 H-test-2 — Unit tests for
 * <ComposeStaleDraftBanner>.
 *
 * Covers FR-019 + a11y:
 *   - role="status" + aria-live="polite" present (catches drift to
 *     role="alert" which contradicts the informational intent).
 *   - Refresh button fires the callback, aria-busy reflects refresh
 *     state.
 *   - Dismiss button fires the callback + disabled while refreshing.
 *   - templateName ICU substitution renders into title body.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ComposeStaleDraftBanner } from '@/components/broadcast/compose/stale-draft-banner';
import enMessages from '@/i18n/messages/en.json';

function renderBanner(
  props: Partial<{
    templateName: string;
    refreshing: boolean;
    onRefresh: () => void;
    onDismiss: () => void;
  }> = {},
) {
  const onRefresh = props.onRefresh ?? vi.fn();
  const onDismiss = props.onDismiss ?? vi.fn();
  const templateName = props.templateName ?? 'Monthly Newsletter';
  const result =
    props.refreshing === undefined
      ? render(
          <NextIntlClientProvider
            locale="en"
            messages={enMessages as Record<string, unknown>}
          >
            <ComposeStaleDraftBanner
              templateName={templateName}
              onRefresh={onRefresh}
              onDismiss={onDismiss}
            />
          </NextIntlClientProvider>,
        )
      : render(
          <NextIntlClientProvider
            locale="en"
            messages={enMessages as Record<string, unknown>}
          >
            <ComposeStaleDraftBanner
              templateName={templateName}
              refreshing={props.refreshing}
              onRefresh={onRefresh}
              onDismiss={onDismiss}
            />
          </NextIntlClientProvider>,
        );
  return { ...result, onRefresh, onDismiss };
}

describe('<ComposeStaleDraftBanner> — R2.1 H-test-2', () => {
  it('renders role=status + aria-live=polite (a11y contract)', () => {
    renderBanner();
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('refresh button fires onRefresh callback', () => {
    const { onRefresh } = renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('aria-busy reflects refreshing prop', () => {
    renderBanner({ refreshing: true });
    const refreshButton = screen.getByRole('button', { name: /refresh/i });
    expect(refreshButton).toHaveAttribute('aria-busy', 'true');
    expect(refreshButton).toBeDisabled();
  });

  it('dismiss button fires onDismiss callback', () => {
    const { onDismiss } = renderBanner();
    // Dismiss button has aria-label "Dismiss refresh prompt for {name}"
    const dismissButton = screen.getByRole('button', {
      name: /dismiss/i,
    });
    fireEvent.click(dismissButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss button is disabled while refreshing', () => {
    renderBanner({ refreshing: true });
    const dismissButton = screen.getByRole('button', {
      name: /dismiss/i,
    });
    expect(dismissButton).toBeDisabled();
  });

  it('templateName ICU substitution lands in body copy', () => {
    renderBanner({ templateName: 'Welcome Series 2026' });
    // Body uses {templateName} placeholder in the i18n message
    expect(
      screen.getByText(/Welcome Series 2026/),
    ).toBeInTheDocument();
  });
});
