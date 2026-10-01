/**
 * `renderTierUpgradesView` (spec 122 US7b-1, T726; boards `Admin-tier-upgrades`
 * + `-mobile`): the queue page's body, shared with the no-DB preview. The
 * section tabs and the queue sit in one AURA card that drops its frame and
 * padding on a phone (the rows are cards of their own); a failed read is an
 * AURA danger alert with Retry.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { renderTierUpgradesView } from '@/app/(staff)/admin/renewals/tier-upgrades/_components/tier-upgrades-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const scope = ns.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en);
    return (key: string) =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], scope) as string;
  },
}));

const T = en.admin.renewals.tier_upgrades;

async function renderView(props: Parameters<typeof renderTierUpgradesView>[0]) {
  const view = (await renderTierUpgradesView(props)) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {view}
    </NextIntlClientProvider>,
  );
}

describe('renderTierUpgradesView', () => {
  it('puts the section tabs and the queue in one card that is frameless on a phone', async () => {
    await renderView({ sectionTabs: <nav>TABS</nav>, queue: <p>QUEUE</p> });
    const card = screen.getByText('QUEUE').closest('.aura-card');
    expect(card).toHaveClass('aura-card--flush-below-sm', 'max-sm:border-0', 'max-sm:p-0');
    expect(card).toContainElement(screen.getByText('TABS'));
  });

  it('leaves the VAT caption to the queue, so an empty queue has none', async () => {
    await renderView({ sectionTabs: null, queue: <p>QUEUE</p> });
    expect(screen.queryByText(T.fees_exclude_vat)).toBeNull();
  });

  it('shows a failed read as an AURA danger alert with Retry, in place of the queue', async () => {
    await renderView({ sectionTabs: null, queue: null, loadFailed: true });
    const alert = screen.getByText(T.error_state.title).closest('.aura-alert');
    expect(alert).toHaveClass('aura-alert--danger');
    expect(alert).toHaveTextContent(T.error_state.subtitle);
    expect(screen.getByRole('button', { name: T.error_state.retry })).toBeInTheDocument();
  });
});
