/**
 * 122 US5a (US5a review, 29 Sep) — the queue page body is one view function,
 * `renderChangeRequestQueueView`, that the page and the no-DB preview route
 * both render, so the preview's screenshots show the page's real layout (the
 * preview used to carry a copy, which drifted once).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
const url = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/change-requests',
  useSearchParams: () => url.current,
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { features: { memberChangeApproval: true }, tenant: { timezone: 'Asia/Bangkok' } } }));
vi.mock('@/lib/rbac', () => ({ requirePagePermission: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/members-change-request-deps', () => ({ asMembersUserId: vi.fn(), buildChangeRequestDeps: vi.fn() }));
vi.mock('@/modules/members', async () => {
  const domain = await import('@/modules/members/domain/change-request/change-request');
  return {
    CHANGE_REQUEST_STATES: domain.CHANGE_REQUEST_STATES,
    CHANGE_REQUEST_OUTCOMES: domain.CHANGE_REQUEST_OUTCOMES,
    listChangeRequestQueue: vi.fn(),
    asMemberId: vi.fn(),
  };
});

// The queue table is an async Server Component, which a client render cannot
// mount; its own tests cover it. Here it is a stand-in table.
vi.mock('@/app/(staff)/admin/change-requests/_components/queue-table', () => ({
  ChangeRequestQueueTable: () => <table data-testid="queue-table-stub" />,
}));

const { renderChangeRequestQueueView } = await import('@/app/(staff)/admin/change-requests/page');

const Q = enMessages.admin.changeRequests.queue;

async function renderView(props: Parameters<typeof renderChangeRequestQueueView>[0]) {
  const tree = await renderChangeRequestQueueView(props);
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

const base = {
  items: [],
  hasMore: false,
  nextHref: null,
  pendingSummary: null,
  deepLinkNotice: null,
  filtered: false,
  memberCompany: null,
  timeZone: 'Asia/Bangkok',
} as const;

describe('renderChangeRequestQueueView', () => {
  it('shows the queue’s own empty state on the default view', async () => {
    await renderView(base);
    expect(screen.getByTestId('queue-empty')).toHaveTextContent(Q.empty);
    expect(screen.getByTestId('queue-empty')).toHaveTextContent(Q.emptyHint);
  });

  it('says nothing matched when filtered', async () => {
    await renderView({ ...base, filtered: true });
    expect(screen.getByTestId('queue-empty')).toHaveTextContent(Q.emptyFiltered);
  });

  it('shows the pending summary only when the page passes one', async () => {
    await renderView({ ...base, pendingSummary: { count: 3, oldestDays: 6 } });
    expect(screen.getByTestId('queue-pending-count')).toBeInTheDocument();
  });

  it('one card holds the filters and the table (list card rule), frameless on a phone', async () => {
    const item = {
      row: {
        request: {
          id: '00000000-0000-4000-9000-000000000012',
          state: 'pending',
          outcome: null,
          withdrawnReason: null,
          submitterRoleAtSubmission: 'primary',
          submittedAt: new Date('2026-09-22T13:16:00Z'),
          decidedAt: null,
          fields: [{ affectsTaxDocuments: false }],
        },
        member: { companyName: 'Midsommar Hospitality Co., Ltd.', memberNumber: 12, status: 'active', archived: false },
        submitter: { displayName: 'Anders Nilsson' },
        decidedBy: null,
      },
      waitingSeconds: 86_400,
      overdue: false,
    };
    await renderView({ ...base, items: [item] as never });
    const card = screen.getByTestId('queue-filters').closest('.aura-card');
    expect(card).not.toBeNull();
    expect(card).toHaveClass('aura-card--flush-below-sm');
    expect(card?.contains(screen.getByTestId('queue-table-stub'))).toBe(true);
  });

  // The filter pattern: the member and submitter scoping are chips in the
  // filter bar, not sentences under it.
  it('the member and submitter scoping are chips in the filter bar', async () => {
    url.current = new URLSearchParams(
      'memberId=11111111-1111-4111-8111-111111111111&submitter=22222222-2222-4222-8222-222222222222',
    );
    try {
      await renderView({ ...base, filtered: true, memberCompany: 'Siam Nordic Trading' });
      const chips = screen.getByTestId('queue-filters').querySelector('.aura-filterbar__chips');
      expect(chips).toHaveTextContent('Member: Siam Nordic Trading');
      expect(chips).toHaveTextContent(enMessages.admin.changeRequests.filters.submitterChip);
      expect(screen.queryByTestId('queue-member-chip')).toBeNull();
      expect(screen.queryByTestId('queue-submitter-chip')).toBeNull();
    } finally {
      url.current = new URLSearchParams();
    }
  });

  it('the empty state sits in the same card, without a second border', async () => {
    await renderView(base);
    const card = screen.getByTestId('queue-filters').closest('.aura-card');
    expect(card?.contains(screen.getByTestId('queue-empty'))).toBe(true);
    expect(screen.getByTestId('queue-empty').querySelector('.aura-empty')).not.toHaveClass('is-bordered');
  });
});
