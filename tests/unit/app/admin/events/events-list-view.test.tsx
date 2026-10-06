/**
 * Spec 122 US9a (T901) — the events list frame on AURA, boards `Admin-events`
 * (+ `-mobile`), in one view the page and the no-DB preview both render
 * (spec Clarifications, Session 2026-10-06):
 *
 *   the page header with "Erase by email" and "Import CSV" (each only for the
 *   roles that see it today; on a phone "Erase by email" sits in a "More
 *   actions" menu) → one list card holding the filters, table and pager.
 *
 * The empty states move to the shared AURA EmptyState, with today's copy and
 * links (`Admin-state-events-no-integration`, `-waiting`).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as never }),
}));

const { renderEventsListView } = await import('@/app/(staff)/admin/events/_components/events-list-view');
const { EventsEmptyState } = await import('@/app/(staff)/admin/events/_components/events-empty-state');

const l = en.admin.events.list;

async function renderView(opts: { canImport: boolean; canEraseByEmail: boolean }) {
  const ui = (await renderEventsListView({ ...opts, children: <p>the list</p> })) as ReactElement;
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('events list frame (board Admin-events)', () => {
  it('has the header, both actions for an admin who may erase, and the list inside one AURA card', async () => {
    const { container } = await renderView({ canImport: true, canEraseByEmail: true });
    expect(screen.getByRole('heading', { level: 1, name: l.title })).toBeInTheDocument();
    expect(screen.getByText(l.subtitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: l.importCsvCta })).toHaveAttribute('href', '/admin/events/import');
    const erase = screen.getAllByRole('link', { name: en.admin.events.erasure.discoverabilityCta })[0]!;
    expect(erase).toHaveAttribute('href', '/admin/events/erasure');
    expect(screen.getByText('the list').closest('.aura-card')).not.toBeNull();
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
  });

  it('offers "Erase by email" from a "More actions" menu on a phone (board Admin-events-mobile)', async () => {
    await renderView({ canImport: true, canEraseByEmail: true });
    fireEvent.click(screen.getByRole('button', { name: l.moreActions }));
    const item = await screen.findByRole('menuitem', { name: en.admin.events.erasure.discoverabilityCta });
    expect(item).toHaveAttribute('href', '/admin/events/erasure');
  });

  it('shows neither action to a reader who may do neither', async () => {
    await renderView({ canImport: false, canEraseByEmail: false });
    expect(screen.queryByRole('link', { name: l.importCsvCta })).toBeNull();
    expect(screen.queryByRole('link', { name: en.admin.events.erasure.discoverabilityCta })).toBeNull();
    expect(screen.queryByRole('button', { name: l.moreActions })).toBeNull();
  });
});

describe('events empty states on the shared AURA EmptyState', () => {
  const ctx = { integrationConfigured: false, everReceivedDelivery: false, totalArchived: 0 };
  const renderEmpty = (props: Parameters<typeof EventsEmptyState>[0]) =>
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <EventsEmptyState {...props} />
      </NextIntlClientProvider>,
    );

  it('no integration: the AURA empty state with today\'s copy and link', () => {
    renderEmpty({ emptyContext: ctx, hasFilters: false, canManageIntegration: true });
    const box = screen.getByText(l.emptyState.noIntegration.title).closest('.aura-empty') as HTMLElement;
    expect(box).not.toBeNull();
    expect(within(box).getByRole('link', { name: l.emptyState.noIntegration.cta })).toHaveAttribute(
      'href',
      '/admin/settings/integrations/eventcreate',
    );
  });

  it('waiting for the first delivery: both links (Admin-state-events-waiting)', () => {
    renderEmpty({ emptyContext: { ...ctx, integrationConfigured: true }, hasFilters: false, canManageIntegration: true });
    const box = screen.getByText(l.emptyState.noDeliveries.title).closest('.aura-empty') as HTMLElement;
    expect(within(box).getByRole('link', { name: l.emptyState.noDeliveries.primaryCta })).toHaveAttribute(
      'href',
      '/admin/settings/integrations/eventcreate#test',
    );
    expect(within(box).getByRole('link', { name: l.emptyState.noDeliveries.cta })).toBeInTheDocument();
  });

  it('nothing matches the filters: an AURA empty state that clears them', () => {
    renderEmpty({ emptyContext: { ...ctx, integrationConfigured: true, everReceivedDelivery: true }, hasFilters: true, canManageIntegration: true });
    const box = screen.getByText(l.emptyState.filteredEmpty).closest('.aura-empty') as HTMLElement;
    expect(within(box).getByRole('link', { name: l.emptyState.clearFilters })).toHaveAttribute('href', '/admin/events');
  });

  it('does not add a second live region beside the filter bar\'s count', () => {
    renderEmpty({ emptyContext: ctx, hasFilters: false, canManageIntegration: true });
    expect(screen.getByText(l.emptyState.noIntegration.title).closest('[role="status"]')).toBeNull();
  });
});
