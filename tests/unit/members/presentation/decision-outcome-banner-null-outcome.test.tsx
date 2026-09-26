/**
 * `DecisionOutcomeBanner` (round 7, tests N4): a decided view with no outcome
 * (impossible by the DB CHECK, reachable only through a hand-built view)
 * renders NOTHING — it never guesses "rejected".
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { DecisionOutcomeBanner } from '@/components/members/change-requests/decision-outcome-banner';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const decided = {
  id: '00000000-0000-4000-8000-000000000001',
  memberId: '11111111-1111-4111-8111-111111111111',
  scope: 'own_contact',
  state: 'decided',
  outcome: 'rejected',
  withdrawnReason: null,
  submittedAt: '2026-09-11T08:00:00.000Z',
  decidedAt: '2026-09-11T09:00:00.000Z',
  decidedBy: 'organisation',
  decisionReason: 'Use the registered phone',
  outcomeAcknowledgedAt: null,
  submittedBy: { contactId: 'c-1', displayName: 'Anna Svensson', isMe: true, roleAtSubmission: 'primary' },
  fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'rejected', appliedAt: null }],
} as unknown as ChangeRequestView;

function renderBanner(view: ChangeRequestView) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DecisionOutcomeBanner request={view} />
    </NextIntlClientProvider>,
  );
}

describe('DecisionOutcomeBanner', () => {
  it('renders the decided banner for a real outcome', () => {
    const { container } = renderBanner(decided);
    expect(container.querySelector('[data-testid="decision-outcome-banner"]')).not.toBeNull();
  });

  it('renders NOTHING when the outcome is null — never a guessed "rejected"', () => {
    const { container } = renderBanner({ ...decided, outcome: null } as unknown as ChangeRequestView);
    expect(container.querySelector('[data-testid="decision-outcome-banner"]')).toBeNull();
    expect(container.textContent).not.toContain(enMessages.portal.changeRequests.outcome.title.rejected);
  });
});

describe('DecisionOutcomeBanner on AURA (spec 122 US3)', () => {
  it('is an AURA alert in the outcome tone that still announces without interrupting', () => {
    const { container } = renderBanner(decided);
    const banner = container.querySelector('[data-testid="decision-outcome-banner"]')!;
    expect(banner).toHaveClass('aura-alert', 'aura-alert--danger');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner.querySelector('.aura-alert__title')?.textContent).toBe(enMessages.portal.changeRequests.outcome.title.rejected);
    expect(container.querySelector('[data-testid="resubmit-link"]')).toHaveClass('aura-btn', 'aura-btn--primary');
    expect(container.querySelector('[data-testid="dismiss-decision"]')).toHaveClass('aura-btn--secondary');
  });
});
