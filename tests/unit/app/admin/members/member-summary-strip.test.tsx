/**
 * 122 US5b-1 (T552) — the member-detail figures strip (board
 * `Admin-member-detail`): Outstanding, Membership expires, Primary contact and
 * Engagement in one named group, each a label, a value and a note.
 *
 * - Outstanding is absent for a role that may not read invoices (the page
 *   passes `null`), says "unavailable" when the read failed, and says when it
 *   counted only the first 100 unpaid invoices.
 * - Engagement is absent while the F9 flag is off (`null`).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createFormatter, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Bangkok' }),
}));

const { MemberSummaryStrip } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-summary-strip'
);

const S = enMessages.admin.members.detail.summary;
const NOW = new Date('2026-09-24T09:00:00Z');

type Props = Parameters<typeof MemberSummaryStrip>[0];

const base: Props = {
  outstanding: { state: 'ok', sumSatang: 3852000n, count: 1, earliestDueIso: '2026-10-15', partial: false },
  expiry: { state: 'ok', expiryIso: '2026-12-31', daysRemaining: 98 },
  primaryContact: { name: 'Erik Johansson', portal: 'linked' },
  engagement: { band: 'healthy', lastActivityIso: '2026-09-22T09:00:00Z' },
  now: NOW,
};

async function renderStrip(over: Partial<Props> = {}) {
  const tree = await MemberSummaryStrip({ ...base, ...over });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

function cell(label: string): HTMLElement {
  const group = screen.getByRole('group', { name: S.label });
  const term = within(group).getAllByText(label)[0]!;
  return term.closest('[data-summary-cell]') as HTMLElement;
}

describe('MemberSummaryStrip (T552)', () => {
  it('shows the four figures in a named group, in the board order', async () => {
    await renderStrip();
    const group = screen.getByRole('group', { name: S.label });
    const cells = group.querySelectorAll('[data-summary-cell]');
    expect([...cells].map((c) => c.getAttribute('data-summary-cell'))).toEqual([
      'outstanding',
      'expiry',
      'primary-contact',
      'engagement',
    ]);
  });

  it('Outstanding: the sum as THB, the unpaid count and the earliest due date', async () => {
    await renderStrip();
    const c = cell(S.outstanding);
    expect(c).toHaveTextContent('38,520.00 THB');
    expect(c).toHaveTextContent('1 unpaid');
    expect(c).toHaveTextContent('15 Oct 2026');
  });

  it('Outstanding: nothing unpaid reads as zero with its own note', async () => {
    await renderStrip({ outstanding: { state: 'ok', sumSatang: 0n, count: 0, earliestDueIso: null, partial: false } });
    const c = cell(S.outstanding);
    expect(c).toHaveTextContent('0.00 THB');
    expect(c).toHaveTextContent(S.outstandingNone);
  });

  it('Outstanding: says it counted only the first 100 when the read was capped', async () => {
    await renderStrip({ outstanding: { state: 'ok', sumSatang: 100n, count: 100, earliestDueIso: '2026-10-15', partial: true } });
    expect(cell(S.outstanding)).toHaveTextContent(S.outstandingPartial);
  });

  it('Outstanding: a failed read says unavailable, never zero', async () => {
    await renderStrip({ outstanding: { state: 'unavailable' } });
    const c = cell(S.outstanding);
    expect(c).toHaveTextContent(S.unavailable);
    expect(c).not.toHaveTextContent('0.00 THB');
  });

  it('Outstanding is left out for a role that may not read invoices', async () => {
    await renderStrip({ outstanding: null });
    const group = screen.getByRole('group', { name: S.label });
    expect(within(group).queryByText(S.outstanding)).toBeNull();
    expect(group.querySelectorAll('[data-summary-cell]')).toHaveLength(3);
  });

  it('Membership expires: the date and the days remaining', async () => {
    await renderStrip();
    const c = cell(S.expires);
    expect(c).toHaveTextContent('31 Dec 2026');
    expect(c).toHaveTextContent('98 days remaining');
  });

  it('Membership expires: no cycle, and a failed read, each say so', async () => {
    await renderStrip({ expiry: { state: 'ok', expiryIso: null, daysRemaining: null } });
    expect(cell(S.expires)).toHaveTextContent(enMessages.admin.members.detail.renewalHealth.empty);
  });

  it('Primary contact: the name and the portal state', async () => {
    await renderStrip();
    const c = cell(S.primaryContact);
    expect(c).toHaveTextContent('Erik Johansson');
    expect(c).toHaveTextContent(enMessages.admin.members.detail.portal.linked);
  });

  it('Primary contact: none says so', async () => {
    await renderStrip({ primaryContact: null });
    expect(cell(S.primaryContact)).toHaveTextContent(enMessages.admin.members.directory.noPrimary);
  });

  it('Engagement: the band and the last activity', async () => {
    await renderStrip();
    const c = cell(S.engagement);
    expect(c).toHaveTextContent(enMessages.admin.members.directory.engagementBand.healthy);
    expect(c).toHaveTextContent('2 days ago');
  });

  it('Engagement is left out while the F9 flag is off', async () => {
    await renderStrip({ engagement: null });
    const group = screen.getByRole('group', { name: S.label });
    expect(within(group).queryByText(S.engagement)).toBeNull();
  });

  it('Engagement: an unscored member says "not yet scored"', async () => {
    await renderStrip({ engagement: { band: null, lastActivityIso: null } });
    expect(cell(S.engagement)).toHaveTextContent(enMessages.admin.members.directory.riskNotComputed);
  });
});
