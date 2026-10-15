/**
 * Spec 122 (2026-10-15, AURA #146) — on phones each list's loading skeleton
 * draws its filter row as the folded bar does: the search and a "Filters"
 * button, with the filter faces hidden below 640px (they live in the sheet).
 * From 640px the row is as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => {
    const t = (key: string) => key;
    return Object.assign(t, { rich: t, raw: t, has: () => true });
  }),
}));

import ChangeRequestsLoading from '@/app/(staff)/admin/change-requests/loading';
import PlansLoading from '@/app/(staff)/admin/plans/loading';
import UsersLoading from '@/app/(staff)/admin/users/loading';
import InvoicesLoading from '@/app/(staff)/admin/invoices/loading';
import CreditNotesLoading from '@/app/(staff)/admin/credit-notes/loading';
import AuditLoading from '@/app/(staff)/admin/audit/loading';
import EventsLoading from '@/app/(staff)/admin/events/loading';
import EventDetailLoading from '@/app/(staff)/admin/events/[eventId]/loading';
import MembersLoading from '@/app/(staff)/admin/members/loading';

afterEach(cleanup);

const LOADERS: ReadonlyArray<readonly [string, () => Promise<ReactElement>]> = [
  ['change requests', ChangeRequestsLoading],
  ['plans', PlansLoading],
  ['users', UsersLoading],
  ['invoices', InvoicesLoading],
  ['credit notes', CreditNotesLoading],
  ['audit', AuditLoading],
  ['events', EventsLoading],
  ['event attendees', EventDetailLoading],
  ['members', MembersLoading],
];

const KEPT_ON_PHONES = new Set(['search', 'result-count', 'filters-button']);

describe('list skeletons fold their filter row on phones', () => {
  it.each(LOADERS)('%s: the search and a Filters button; the filter faces hide below 640px', async (_name, Loading) => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        {await Loading()}
      </NextIntlClientProvider>,
    );
    const row = container.querySelector('[data-skeleton="filters"]');
    expect(row).not.toBeNull();
    const button = row!.querySelectorAll('[data-skeleton="filters-button"]');
    expect(button).toHaveLength(1);
    expect(button[0]).toHaveClass('sm:hidden');
    for (const child of row!.children) {
      if (KEPT_ON_PHONES.has(child.getAttribute('data-skeleton') ?? '')) continue;
      expect(child).toHaveClass('max-sm:hidden');
    }
  });
});
