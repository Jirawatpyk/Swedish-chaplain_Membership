/**
 * F119 T113 (US4-AS6; contracts/dashboard-and-notifications.md § 1.2
 * "Preserved: … the manager read-only mode") — a `manager` sees everything
 * and can act on nothing.
 *
 *   - The route returns the same list to a manager as to an admin: holding
 *     `broadcasts.read` is the whole gate, and nothing filters by role.
 *   - The rendered queue carries NO action control for a read-only viewer —
 *     absent, not disabled: no approve / reject buttons, no selection
 *     checkboxes, nothing `disabled` / `aria-disabled` left standing where a
 *     control used to be. A disabled button is silent to a screen reader and
 *     invites a click that does nothing.
 *   - Positive controls: a `member` session is refused by the route, and the
 *     same rows rendered for a writer DO carry the controls — so "absent" is
 *     the read-only mode at work, not a render that lost its actions.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import type { QueueRow } from '@/components/broadcast/admin/queue-table';
import { stageOf } from '@/modules/broadcasts/domain/stage/broadcast-stage';
import { turnOf } from '@/modules/broadcasts/domain/stage/whose-turn';
import { makeApprovalBroadcast } from '../../helpers/eblast-approval-fakes';
import { dash, getQueue, resetDashboard } from '../../helpers/eblast-dashboard-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-dashboard-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-dashboard-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-dashboard-route-harness')).loggerMock());
vi.mock('@/lib/db', async () => (await import('../../helpers/eblast-dashboard-route-harness')).dbMock());
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-dashboard-route-harness')).broadcastsBarrelMock(),
);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: ns } as unknown as Parameters<
      typeof createTranslator
    >[0]),
  ),
  getLocale: vi.fn(async () => 'en'),
}));

/**
 * `NextIntlClientProvider` typed with OPTIONAL children, so this `.ts` file can
 * pass them as `createElement`'s third argument (its props type requires them,
 * and `react/no-children-prop` forbids passing them as a prop).
 */
const IntlProvider = NextIntlClientProvider as unknown as (props: {
  locale: string;
  messages: typeof enMessages;
  children?: React.ReactNode;
}) => React.ReactElement;

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});
beforeEach(() => {
  vi.useRealTimers();
  resetDashboard();
});
afterEach(cleanup);

const STATUSES: readonly BroadcastStatus[] = [
  'submitted',
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
  'approved',
  'sent',
  'rejected',
];

function queueRow(status: BroadcastStatus, i: number): QueueRow {
  return {
    broadcastId: `11111111-1111-4111-8111-00000000000${i}`,
    status,
    stage: stageOf(status),
    whoseTurn: turnOf(status),
    subject: `E-Blast ${i}`,
    requestedByMemberId: '22222222-2222-4222-8222-222222222222',
    requestedByMemberDisplayName: 'Acme Co',
    actorRole: 'member_self_service',
    segmentType: 'all_members',
    estimatedRecipientCount: 10,
    submittedAt: '2026-09-20T08:00:00.000Z',
    createdAt: '2026-09-20T07:00:00.000Z',
    stageEnteredAt: '2026-09-20T08:00:00.000Z',
    currentRound: 1,
    proposedSendAt: '2026-10-01T03:00:00.000Z',
    confirmedSendAt: null,
    delivery: status === 'sent' ? { recipients: 10, delivered: 9, bounced: 1, complained: 0 } : null,
  };
}

async function renderQueue(readOnly: boolean) {
  const { QueueTable } = await import('@/components/broadcast/admin/queue-table');
  const ui = await QueueTable({ rows: STATUSES.map(queueRow), readOnly });
  return render(createElement(IntlProvider, { locale: 'en', messages: enMessages }, ui));
}

describe('a manager sees everything and can act on nothing (T113, US4-AS6)', () => {
  it('the full list is returned and every action control is absent, not disabled', async () => {
    dash.rows = STATUSES.map((status, i) =>
      makeApprovalBroadcast({ broadcastId: asBroadcastId(`11111111-1111-4111-8111-00000000000${i}`), status }),
    );
    const query = '?' + STATUSES.map((s) => `status=${s}`).join('&');

    dash.role = 'admin';
    const asAdmin = await getQueue(query);
    dash.role = 'manager';
    const asManager = await getQueue(query);
    expect(asManager.status).toBe(200);
    expect(asManager.body['items']).toEqual(asAdmin.body['items']);
    expect((asManager.body['items'] as unknown[]).length).toBe(STATUSES.length);

    const { container } = await renderQueue(true);
    // Every row is there — the subject links, in both presentations.
    for (let i = 0; i < STATUSES.length; i += 1) {
      expect(screen.getAllByRole('link', { name: `E-Blast ${i}` }).length).toBeGreaterThan(0);
    }
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(container.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0);
  });

  it('positive control — a member session is refused by the route', async () => {
    dash.role = 'member';
    const { status } = await getQueue('?status=submitted');
    expect(status).toBe(403);
  });

  it('positive control — the same rows rendered for a writer DO carry the review controls', async () => {
    await renderQueue(false);
    expect(screen.getAllByRole('button', { name: /approve/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
  });
});
