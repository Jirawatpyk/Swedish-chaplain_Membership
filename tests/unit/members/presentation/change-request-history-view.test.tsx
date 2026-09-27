/**
 * Spec 122 US3 (`Portal-change-requests` board) — a withdrawn request's card
 * says when it was withdrawn, as a decided one says when it was decided.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
}));

const { renderChangeRequestHistoryView } = await import('@/components/members/change-requests/change-request-history-view');

const WITHDRAWN = {
  id: '00000000-0000-4000-8000-000000000003',
  memberId: '11111111-1111-4111-8111-111111111111',
  scope: 'own_contact',
  state: 'withdrawn',
  outcome: null,
  withdrawnReason: 'member',
  withdrawnAt: '2026-05-12T09:30:00.000Z',
  submittedAt: '2026-05-12T09:02:00.000Z',
  submittedBy: { contactId: 'c-1', displayName: 'Anna Lindqvist', isMe: true },
  decidedAt: null,
  decidedBy: 'organisation',
  decisionReason: null,
  outcomeAcknowledgedAt: null,
  fields: [{ key: 'role_title', target: 'contact', seen: 'Director', proposed: 'Managing Director', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
} as ChangeRequestView;

describe('change-request history view', () => {
  it('says when a withdrawn request was withdrawn', async () => {
    const tree = await renderChangeRequestHistoryView({ items: [WITHDRAWN], nextCursor: null, isFirstPage: true });
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
        {tree as ReactElement}
      </NextIntlClientProvider>,
    );
    expect(html).toContain('Submitted by you · withdrawn 12 May 2026');
  });
});
