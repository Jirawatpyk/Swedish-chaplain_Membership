// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1271 parity) — two board elements of `Proposal-compose`
 * the first build missed:
 * - the quota is one line, "3 of 6 E-Blasts left in 2026 · 1 reserved", with
 *   the bar beside it, not the benefits tab's four-counter card;
 * - "You can cancel this broadcast at any time until an admin approves it."
 *   is said once, in the submit confirmation, not again under the form.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QuotaDisplay } from '@/components/broadcast/quota-display';

vi.mock('@/components/broadcast/preview-pane', () => ({ PreviewPane: () => null }));
vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(): React.ReactElement {
      return <textarea aria-label="Message body" />;
    },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { ComposeForm } = await import('@/components/broadcast/compose-form');
const q = enMessages.portal.broadcasts.quota;
const QUOTA = { used: 2, reserved: 1, remaining: 3, cap: 6, quotaYear: 2026, planName: 'Premium Corporate' };

afterEach(cleanup);

describe('the one-line quota', () => {
  it('states what is left and what is reserved, with the bar, and no counters', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QuotaDisplay initial={QUOTA} live={false} variant="line" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('quota-display')).toHaveTextContent('3 of 6 E-Blasts left in 2026 · 1 reserved');
    expect(screen.getByRole('progressbar', { name: q.progressLabel })).toBeInTheDocument();
    expect(screen.queryByText(q.cap)).toBeNull();
  });

  it('with nothing reserved, says what is left alone', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QuotaDisplay initial={{ ...QUOTA, reserved: 0, remaining: 4 }} live={false} variant="line" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('quota-display')).toHaveTextContent(/^4 of 6 E-Blasts left in 2026$/);
  });
});

describe('member compose chrome', () => {
  it('uses the one-line quota and says "you can cancel" only in the confirmation', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(QUOTA), { status: 200 })));
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposeForm audienceCeiling={500} audienceMode="primary_only" initialQuota={QUOTA} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('quota-display')).toHaveTextContent('3 of 6 E-Blasts left in 2026');
    expect(screen.queryByText(/You can cancel this broadcast at any time/)).toBeNull();
    vi.unstubAllGlobals();
  });
});
