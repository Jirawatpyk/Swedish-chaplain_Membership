// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 follow-up (PR C) — the E-Blast sending rules on the member
 * compose page. It reuses the per-company acknowledgement the portal banner
 * records (`members.broadcasts_acknowledged_at`, POST
 * /api/portal/broadcasts/acknowledge):
 * - not yet acknowledged: the banner's warning alert, with "I acknowledge";
 * - acknowledged: one line, "E-Blast sending rules", with "Read again".
 * It explains the rules; it never gates Save or Submit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { toast } from '@/lib/toast';

const refresh = vi.hoisted(() => vi.fn());
const readOnlyToast = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/components/shell/use-read-only-toast', () => ({ useReadOnlyToast: () => readOnlyToast }));

const { ComposeSendingRules } = await import('@/components/broadcast/compose/sending-rules');
const { BROADCASTS_ACKNOWLEDGED_EVENT, resetAcknowledgedForTests } = await import(
  '@/components/broadcast/acknowledgement/use-acknowledge-broadcasts-terms'
);

const ack = enMessages.portal.broadcasts.banner.acknowledgement;
const rules = enMessages.portal.broadcasts.compose.rules;
const PRIVACY = 'https://swecham.example/privacy';

function renderRules(acknowledgedAt: string | null): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeSendingRules memberId="m-1" acknowledgedAt={acknowledgedAt} locale="en" privacyPolicyUrl={PRIVACY} />
    </NextIntlClientProvider>,
  );
}

function readOnly503(): Response {
  return new Response(JSON.stringify({ error: 'read-only-mode', retryAfterSeconds: 300 }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ wasNew: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  resetAcknowledgedForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('not yet acknowledged', () => {
  it('shows the rules in full with "I acknowledge"', () => {
    renderRules(null);
    expect(screen.getByText(ack.title)).toBeVisible();
    expect(screen.getByText(ack.body)).toBeVisible();
    expect(screen.getByRole('link', { name: ack.privacyPolicyLink })).toHaveAttribute('href', PRIVACY);
    // UX M1: Submit stays the page's only primary button.
    expect(screen.getByRole('button', { name: ack.acknowledge })).not.toHaveClass('aura-btn--primary');
    expect(screen.queryByRole('button', { name: rules.readAgain })).toBeNull();
    // The member is already composing: no "Remind me later" here.
    expect(screen.queryByRole('button', { name: ack.remindLater })).toBeNull();
  });

  it('records the acknowledgement, collapses to the line and tells the banner', async () => {
    const onAcknowledged = vi.fn();
    window.addEventListener(BROADCASTS_ACKNOWLEDGED_EVENT, onAcknowledged);
    renderRules(null);
    await userEvent.setup().click(screen.getByRole('button', { name: ack.acknowledge }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/portal/broadcasts/acknowledge',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ locale: 'en' }) }),
    );
    const readAgain = await screen.findByRole('button', { name: rules.readAgain });
    expect(readAgain).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(readAgain);
    // The rules panel stays mounted (aria-controls), closed.
    expect(screen.getByText(ack.body)).not.toBeVisible();
    expect(toast.success).toHaveBeenCalledWith(ack.toastAcknowledged, expect.anything());
    // /code-review: no router.refresh — it re-ran the whole compose page (and
    // could lose an unsaved draft). The portal banner hears an event instead.
    expect(refresh).not.toHaveBeenCalled();
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
  });

  it('a read-only refusal shows the read-only toast and keeps the rules open', async () => {
    fetchMock.mockResolvedValueOnce(readOnly503());
    renderRules(null);
    await userEvent.setup().click(screen.getByRole('button', { name: ack.acknowledge }));
    await waitFor(() => expect(readOnlyToast).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: ack.acknowledge })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500', () => Promise.resolve(new Response('{}', { status: 500 }))],
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s shows the failure toast and keeps the rules open', async (_label, reply) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementationOnce(reply);
    renderRules(null);
    await userEvent.setup().click(screen.getByRole('button', { name: ack.acknowledge }));
    await waitFor(() =>
      // UX M2: there is no banner on this page, so the hint names the rules.
      expect(toast.error).toHaveBeenCalledWith(ack.toastAcknowledgeFailed, {
        description: rules.toastAcknowledgeFailedHint,
      }),
    );
    expect(screen.getByRole('button', { name: ack.acknowledge })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('acknowledged', () => {
  it('shows one line; "Read again" opens and closes the same rules', async () => {
    renderRules('2026-10-01T03:00:00.000Z');
    expect(screen.getByText(rules.line)).toBeVisible();
    expect(screen.queryByText(ack.body)).not.toBeVisible();
    expect(screen.queryByRole('button', { name: ack.acknowledge })).toBeNull();

    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: rules.readAgain });
    // a11y M1: one fixed name, the state in aria-expanded, the line as context;
    // the panel stays mounted so aria-controls always resolves.
    expect(toggle).toHaveAccessibleDescription(rules.line);
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).not.toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName(rules.readAgain);
    expect(screen.getByText(ack.body)).toBeVisible();
    expect(screen.getByRole('link', { name: ack.privacyPolicyLink })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(ack.body)).not.toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a remount after acknowledging (phone ↔ desktop) keeps the line', async () => {
    renderRules(null);
    await userEvent.setup().click(screen.getByRole('button', { name: ack.acknowledge }));
    await screen.findByRole('button', { name: rules.readAgain });
    cleanup();
    // The server prop is still null: nothing refreshed it.
    renderRules(null);
    expect(screen.getByRole('button', { name: rules.readAgain })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ack.acknowledge })).toBeNull();
  });
});
