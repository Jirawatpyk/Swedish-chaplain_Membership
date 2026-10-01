/**
 * `<MembersWithoutCycleTray>` on AURA (spec 122 US7a, T707; board
 * `Admin-renewals`): an AURA `Card` titled "Members without a renewal cycle"
 * with its explanation, each member a link to their record beside the join
 * date; a load failure is an AURA danger alert in the same card.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { MembersWithoutCycleTray } from '@/app/(staff)/admin/renewals/_components/members-without-cycle-tray';

async function renderTray(resultPromise: Parameters<typeof MembersWithoutCycleTray>[0]['resultPromise']) {
  const el = await MembersWithoutCycleTray({ tenantSlug: 'tenant-a', resultPromise });
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {el}
    </NextIntlClientProvider>,
  );
}

describe('<MembersWithoutCycleTray> on AURA', () => {
  it('is an AURA card with the title and explanation, each member linking to their record', async () => {
    await renderTray(
      Promise.resolve({
        ok: true as const,
        v: {
          ok: true as const,
          value: {
            items: [{ memberId: 'm-1', companyName: 'Nordic Timber', registrationDate: '2026-09-24' }],
            totalCount: 1,
          },
        },
      }) as never,
    );
    const heading = screen.getByRole('heading', { name: 'Members without a renewal cycle' });
    expect(heading.closest('.aura-card')).not.toBeNull();
    expect(screen.getByText(en.admin.renewals.membersWithoutCycle.banner.description)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View member Nordic Timber' })).toHaveAttribute(
      'href',
      '/admin/members/m-1',
    );
    expect(screen.getByText('24 September 2026')).toBeInTheDocument();
  });

  it('a load failure is an AURA danger alert inside the card', async () => {
    await renderTray(Promise.resolve({ ok: false as const, e: new Error('boom') }) as never);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(en.admin.renewals.membersWithoutCycle.loadFailed);
    expect(alert.closest('.aura-card')).not.toBeNull();
  });
});
