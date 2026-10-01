/**
 * `renderTasksQueueView` — 122 US7b-2 (T735), board `Admin-renewal-tasks`:
 * the page body, shared with the no-DB preview. The section tabs, the queue
 * and the "Next 50" footer sit in one AURA card that drops its frame on a
 * phone; a failed read is an AURA danger alert with Retry.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { renderTasksQueueView } from '@/app/(staff)/admin/renewals/tasks/_components/tasks-queue-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const scope = ns.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en);
    return (key: string) =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], scope) as string;
  },
}));

const T = en.admin.renewals.tasks;

async function renderView(props: Parameters<typeof renderTasksQueueView>[0]) {
  const view = (await renderTasksQueueView(props)) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {view}
    </NextIntlClientProvider>,
  );
}

describe('renderTasksQueueView', () => {
  it('puts the section tabs and the queue in one card that is frameless on a phone', async () => {
    await renderView({ sectionTabs: <nav>TABS</nav>, queue: <p>QUEUE</p>, nextHref: null });
    const card = screen.getByText('QUEUE').closest('.aura-card');
    expect(card).toHaveClass('aura-card--flush-below-sm', 'max-sm:border-0', 'max-sm:p-0');
    expect(card).toContainElement(screen.getByText('TABS'));
  });

  it('adds "Showing 50 per page" and a secondary "Next 50" link when there is a next page', async () => {
    await renderView({ sectionTabs: null, queue: <p>QUEUE</p>, nextHref: '/admin/renewals/tasks?cursor=abc' });
    expect(screen.getByText(T.pagination.showingFirst)).toBeInTheDocument();
    const next = screen.getByRole('link', { name: T.pagination.next });
    expect(next).toHaveAttribute('href', '/admin/renewals/tasks?cursor=abc');
    expect(next).toHaveClass('aura-btn--secondary');
  });

  it('has no footer on the last page', async () => {
    await renderView({ sectionTabs: null, queue: <p>QUEUE</p>, nextHref: null });
    expect(screen.queryByRole('link', { name: T.pagination.next })).toBeNull();
  });

  it('shows a failed read as an AURA danger alert with Retry, in place of the queue', async () => {
    await renderView({ sectionTabs: null, queue: null, nextHref: null, loadFailed: true });
    const alert = screen.getByText(T.error_state.title).closest('.aura-alert');
    expect(alert).toHaveClass('aura-alert--danger');
    expect(alert).toHaveTextContent(T.error_state.subtitle);
    expect(screen.getByRole('button', { name: T.error_state.retry })).toBeInTheDocument();
  });
});
