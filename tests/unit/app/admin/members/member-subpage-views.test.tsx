/**
 * 122 US5b-1 (T558) — the member timeline and benefits pages as their boards
 * (`Admin-member-timeline`, `Admin-member-benefits`), each one view function
 * the page and the no-DB preview route both render:
 *
 * - the page title with "Back to member" (desktop; on a phone the shell's
 *   back link does it);
 * - timeline: one section named by the company with the event count;
 * - benefits: the company under the title, and "Send reminder" only when the
 *   page passes a reminder link (admin with a primary contact).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createFormatter, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Bangkok' }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/members/m-1/timeline',
  useSearchParams: () => new URLSearchParams(),
}));

const { renderMemberTimelineView } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-timeline-view'
);
const { renderMemberBenefitsView } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-benefits-view'
);

const TL = enMessages.admin.members.timeline;
const BN = enMessages.admin.members.benefits;

async function mount(tree: Promise<unknown>) {
  const el = (await tree) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {el}
    </NextIntlClientProvider>,
  );
}

describe('renderMemberTimelineView (T558)', () => {
  it('the title, the way back, and one section named by the company with the count', async () => {
    await mount(
      renderMemberTimelineView({
        member: { memberId: 'm-1', companyName: 'Siam Nordic Trading Co., Ltd.' },
        initialEvents: [],
        initialCursor: null,
        totalEvents: 64,
        hasFilter: false,
        filterKey: 'k',
      }),
    );
    expect(screen.getByRole('heading', { level: 1, name: TL.title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: TL.backToDetail })).toHaveAttribute('href', '/admin/members/m-1');
    const section = screen.getByRole('region', { name: 'Siam Nordic Trading Co., Ltd.' });
    expect(section).toHaveTextContent('64 events');
  });
});

describe('renderMemberBenefitsView (T558)', () => {
  const usage = {
    membershipYear: 2026,
    elapsedYearPct: 73,
    quantifiable: [],
    active: [],
    aggregateConsumedPct: 8,
    underUseWarning: false,
  };

  it('the title with the company under it and the way back', async () => {
    await mount(
      renderMemberBenefitsView({
        member: { memberId: 'm-1', companyName: 'Siam Nordic Trading Co., Ltd.' },
        usage,
        suspended: false,
        reminderHref: undefined,
        locale: 'en',
      }),
    );
    const h1 = screen.getByRole('heading', { level: 1, name: BN.title });
    expect(h1.closest('header')).toHaveTextContent('Siam Nordic Trading Co., Ltd.');
    expect(screen.getByRole('link', { name: BN.backToDetail })).toHaveAttribute('href', '/admin/members/m-1');
    expect(screen.queryByRole('link', { name: BN.staffActions.sendReminder })).toBeNull();
  });

  it('offers "Send reminder" when the page passes the reminder link', async () => {
    await mount(
      renderMemberBenefitsView({
        member: { memberId: 'm-1', companyName: 'Siam Nordic' },
        usage,
        suspended: false,
        reminderHref: 'mailto:erik@example.com?subject=x',
        locale: 'en',
      }),
    );
    // Two copies, one per width (the phone board puts it under the title).
    for (const link of screen.getAllByRole('link', { name: BN.staffActions.sendReminder })) {
      expect(link).toHaveAttribute('href', 'mailto:erik@example.com?subject=x');
    }
  });

  // Board `Admin-member-benefits`: "Included benefits" is an h3 and each
  // benefit an outline badge.
  it('lists included benefits under an h3 as outline badges', async () => {
    const { container } = await mount(
      renderMemberBenefitsView({
        member: { memberId: 'm-1', companyName: 'Siam Nordic' },
        usage: { ...usage, active: [{ key: 'm2m_benefits' }] } as never,
        suspended: false,
        reminderHref: undefined,
        locale: 'en',
      }),
    );
    expect(screen.getByRole('heading', { level: 3, name: enMessages.benefits.card.activeHeading })).toBeInTheDocument();
    expect(container.querySelector('.aura-badge[class*="outline"]')).not.toBeNull();
  });
});
