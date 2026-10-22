/**
 * Layout B (maintainer, 22 Oct; board `Admin-member-detail`): the member's
 * change requests as a compact card in the main column. Every pending request
 * with Review; at most three decided or withdrawn ones as one line each
 * (fields · status · who decided · when); "View all" to the queue filtered to
 * this member. A failed read stays distinct from "none yet".
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
}));

const { MemberChangeRequestsCard } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-change-requests-section'
);
type Row = Parameters<typeof MemberChangeRequestsCard>[0]['rows'][number];

const CR = enMessages.admin.members.changeRequests;
const R = enMessages.admin.changeRequests.review;

const pending = (id: string): Row => ({
  id,
  status: { state: 'pending' },
  fieldKeys: ['billing_address'],
  submitterName: 'Erik Johansson',
  submitterRole: R.roles.primary,
  submittedAtIso: '2026-10-20T03:00:00.000Z',
  decidedByName: null,
  decidedAtIso: null,
});
const decided = (id: string): Row => ({
  id,
  status: { state: 'decided', outcome: 'approved' },
  fieldKeys: ['phone', 'role_title'],
  submitterName: 'Erik Johansson',
  submitterRole: R.roles.primary,
  submittedAtIso: '2026-09-10T03:00:00.000Z',
  decidedByName: 'Anna Berg',
  decidedAtIso: '2026-09-12T03:00:00.000Z',
});

async function renderCard(rows: readonly Row[], loadFailed = false) {
  const el = (await MemberChangeRequestsCard({ memberId: 'm-1', rows, loadFailed })) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {el}
    </NextIntlClientProvider>,
  );
}

describe('MemberChangeRequestsCard', () => {
  it('lists each pending request with its fields and a Review link', async () => {
    await renderCard([pending('cr-1'), pending('cr-2')]);
    const items = screen.getAllByTestId('member-change-request-pending');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(enMessages.portal.changeRequests.diff.labels.billing_address);
    expect(items[0]).toHaveTextContent('Erik Johansson');
    expect(within(items[0]!).getByRole('link', { name: new RegExp(`^${CR.review}`) })).toHaveAttribute(
      'href',
      '/admin/change-requests/cr-1',
    );
  });

  it('shows at most three decided requests, one line each, with who decided', async () => {
    await renderCard([pending('cr-1'), decided('d-1'), decided('d-2'), decided('d-3'), decided('d-4')]);
    const history = screen.getAllByTestId('member-change-request-history');
    expect(history.map((h) => h.getAttribute('data-request-id'))).toEqual(['d-1', 'd-2', 'd-3']);
    expect(history[0]).toHaveTextContent(R.outcome.approved);
    expect(history[0]).toHaveTextContent('Anna Berg');
    expect(history[0]).toHaveTextContent(enMessages.portal.changeRequests.diff.labels.phone);
    // one line, no diff table
    expect(screen.queryByTestId('change-request-diff')).toBeNull();
  });

  it('View all goes to the queue filtered to this member', async () => {
    await renderCard([decided('d-1')]);
    expect(screen.getByRole('link', { name: CR.viewAll })).toHaveAttribute('href', '/admin/change-requests?memberId=m-1');
  });

  it('a failed read is its own state, not "none yet"', async () => {
    await renderCard([], true);
    expect(screen.getByTestId('member-change-requests-unavailable')).toHaveTextContent(CR.loadFailed);
    expect(screen.queryByText(CR.empty)).toBeNull();
  });

  it('no requests reads as the empty state', async () => {
    await renderCard([]);
    expect(screen.getByText(CR.empty)).toBeInTheDocument();
  });
});
