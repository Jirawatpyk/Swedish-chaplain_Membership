/**
 * Phase 5 Round 1 R2.1 H-test-5 — Unit tests for
 * <AdminTemplateEditConfirmStarter>.
 *
 * Covers:
 *   1. localStorage scoping is per-(tenant, templateId) — dismissing
 *      template A does NOT hide the banner for template B (regression
 *      guard for FR-021 starter-warning isolation).
 *   2. localStorage write failure (quota/private mode) closes the
 *      banner for the session without crashing.
 *   3. Lazy initializer reads localStorage on first mount — banner
 *      stays hidden for already-dismissed templates without a
 *      hydration flash.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { AdminTemplateEditConfirmStarter } from '@/components/broadcast/admin/template-edit-confirm-starter';
import enMessages from '@/i18n/messages/en.json';

const TEMPLATE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEMPLATE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function renderBanner(templateId: string, name = 'Monthly Newsletter') {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages as Record<string, unknown>}
    >
      <AdminTemplateEditConfirmStarter
        templateId={templateId}
        templateName={name}
      />
    </NextIntlClientProvider>,
  );
}

describe('<AdminTemplateEditConfirmStarter> — R2.1 H-test-5', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('renders the starter-edit warning banner on first mount', () => {
    renderBanner(TEMPLATE_A);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(
      screen.getByText(/starter template/i),
    ).toBeInTheDocument();
  });

  it('dismissal of template A does NOT hide banner for template B (per-templateId scoping)', () => {
    // Mount + dismiss banner for template A.
    const { unmount } = renderBanner(TEMPLATE_A);
    fireEvent.click(
      screen.getByRole('button', { name: /dismiss starter warning/i }),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    unmount();

    // Mount banner for template B — must still be visible.
    renderBanner(TEMPLATE_B);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('lazy initializer reads previously-dismissed flag from localStorage', () => {
    // Pre-seed localStorage as if a previous session dismissed it.
    window.localStorage.setItem(
      'broadcasts.starter-edit-dismissed:' + TEMPLATE_A,
      '1',
    );
    renderBanner(TEMPLATE_A);
    // Banner hidden from first paint (no flash).
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('localStorage write failure closes banner for session without crashing', () => {
    // R3.6 L-4 — vi.spyOn replaces direct method-assignment.
    // jsdom's localStorage prototype-method assignment can silently
    // no-op in some versions; spyOn forces the override + restores
    // automatically via afterEach `vi.restoreAllMocks` (covered by
    // top-level setup).
    const spy = vi
      .spyOn(window.localStorage, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
    try {
      renderBanner(TEMPLATE_A);
      expect(screen.getByRole('status')).toBeInTheDocument();
      // Dismiss — should not throw.
      expect(() =>
        fireEvent.click(
          screen.getByRole('button', { name: /dismiss starter warning/i }),
        ),
      ).not.toThrow();
      // Banner is hidden for THIS session even though persist failed.
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});
