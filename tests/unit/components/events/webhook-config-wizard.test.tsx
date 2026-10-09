/**
 * Spec 122 US9c (T941) — the EventCreate setup wizard on AURA (board
 * `Admin-eventcreate`, Clarifications 2026-10-09, US9c start).
 *
 * - the steps are AURA `Stepper` (a navigation landmark named "EventCreate
 *   setup steps"); the current step follows the wizard's phase and earlier
 *   steps read as completed;
 * - a fresh tenant starts on "Generate secret" with the tier notice as a
 *   note; a configured tenant starts on "Test & manage";
 * - a 409 on generate keeps today's branch: the toast, step 3, a refresh;
 * - the configured view shows the webhook URL and the masked secret as
 *   labelled value boxes, with Rotate and Send test event;
 * - the grace banner keeps `role=status` and its testid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { IntegrationConfigView } from '@/lib/events-admin-integration-types';

const nav = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: nav.refresh }),
  usePathname: () => '/admin/settings/integrations/eventcreate',
  useSearchParams: () => new URLSearchParams(),
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { WebhookConfigWizard } = await import('@/components/events/webhook-config-wizard');

const w = en.admin.integrations.eventcreate.wizard;
const URL_ = 'https://swecham.dxtspace.com/api/webhooks/eventcreate/v1/swecham';

const FRESH: IntegrationConfigView = {
  secretConfigured: false,
  webhookUrl: URL_,
  recentDeliveries: [],
  recentDeliveriesIncludeTests: false,
};

function configured(graceActiveUntil: string | null = null): IntegrationConfigView {
  return {
    secretConfigured: true,
    webhookUrl: URL_,
    secretLastFour: '7f3a' as never,
    graceActiveUntil,
    ingestEnabled: true,
    lastReceivedAt: null,
    recentDeliveries: [],
    recentDeliveriesIncludeTests: false,
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWizard(view: IntegrationConfigView) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      <WebhookConfigWizard view={view} walkthrough={<p>walkthrough</p>} />
    </NextIntlClientProvider>,
  );
}

function currentStep(): HTMLElement {
  const steps = screen.getByRole('navigation', { name: w.stepsLabel });
  const current = within(steps)
    .getAllByRole('listitem')
    .find((li) => li.getAttribute('aria-current') === 'step');
  if (!current) throw new Error('no current step');
  return current;
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('<WebhookConfigWizard> on AURA', () => {
  it('starts a fresh tenant on "Generate secret", with the tier notice as a note', () => {
    renderWizard(FRESH);
    expect(currentStep()).toHaveTextContent(w.phaseAStep);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(w.tierNotice.title);
    expect(screen.getByRole('button', { name: w.generateButton })).toBeEnabled();
  });

  it('starts a configured tenant on "Test & manage", with earlier steps completed', () => {
    renderWizard(configured());
    expect(currentStep()).toHaveTextContent(w.phaseCStep);
    const steps = within(screen.getByRole('navigation', { name: w.stepsLabel })).getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent(/completed/i);
    expect(steps[1]).toHaveTextContent(/completed/i);
  });

  it('shows the webhook URL and the masked secret as labelled value boxes', () => {
    renderWizard(configured());
    expect(screen.getByRole('group', { name: w.webhookUrlLabel })).toHaveTextContent(URL_);
    const secret = screen.getByRole('group', { name: w.secretLabel });
    expect(secret).toHaveTextContent(/^.*whsec_•{16}7f3a/);
    expect(within(secret).getByText(/whsec_•{16}7f3a/)).toHaveAttribute('aria-hidden', 'true');
    expect(
      within(secret).getByText(en.admin.integrations.eventcreate.phaseA.maskedSecret.replace('{lastFour}', '7f3a')),
    ).toHaveClass('sr-only');
    expect(within(secret).getByRole('button', { name: w.rotateButton })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.admin.integrations.eventcreate.phaseC.test.sendTest })).toBeEnabled();
  });

  it('keeps the 409 branch: the toast, step 3 and a refresh', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({}) } as Response);
    renderWizard(FRESH);
    fireEvent.click(screen.getByRole('button', { name: w.generateButton }));
    await flush();
    expect(toastMock.error).toHaveBeenCalledWith(w.generateAlreadyExists);
    expect(nav.refresh).toHaveBeenCalled();
    expect(currentStep()).toHaveTextContent(w.phaseCStep);
  });

  it('keeps the grace banner as a polite status with its testid, and the grace chip', () => {
    renderWizard(configured('2026-10-10T03:00:00.000Z'));
    const banner = screen.getByTestId('grace-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(w.graceBanner.title);
    expect(screen.getByText(/Old secret still verifies until/)).toBeInTheDocument();
  });
});
