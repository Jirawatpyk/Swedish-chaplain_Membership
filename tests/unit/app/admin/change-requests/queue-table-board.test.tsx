/**
 * 122 US5a — the change-request queue as the `Admin-change-requests` boards
 * draw it: an "Actions" column head, rows centred on their line, and on a
 * phone a card whose title (company and member number, no field label)
 * shares its first line with the Review button.
 */
import { describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { ChangeRequestQueueItem } from '@/modules/members';

vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${ns}.${key}${values ? JSON.stringify(values) : ''}`;
    return t;
  },
  getLocale: async () => 'en',
}));

import { ChangeRequestQueueTable } from '@/app/(staff)/admin/change-requests/_components/queue-table';
import { TIGHT_CELLS_IN_NARROWEST_GRID } from '@/components/shell/aura-classes';

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
      fields: [{ affectsTaxDocuments: true }, { affectsTaxDocuments: false }],
    },
    member: { companyName: 'Midsommar Hospitality Co., Ltd.', memberNumber: 12, status: 'active', archived: false },
    submitter: { displayName: 'Anders Nilsson' },
    decidedBy: null,
  },
  waitingSeconds: 6 * 86_400,
  overdue: true,
} as unknown as ChangeRequestQueueItem;

function render(ui: React.ReactElement) {
  return rtlRender(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('change-request queue as on the board (US5a)', () => {
  it('shows the Actions column head; the member cell carries no card label; rows centred by AURA', async () => {
    render(await ChangeRequestQueueTable({ items: [item] }));
    const head = screen.getByRole('columnheader', { name: 'admin.changeRequests.queue.columns.actions' });
    expect(head.querySelector('.sr-only')).toBeNull();
    const row = screen.getByTestId('queue-row');
    const [memberCell] = within(row).getAllByRole('cell');
    expect(memberCell).not.toHaveAttribute('data-label');
    // AURA 5.13 (#81): the static Table's own vertical centring.
    expect(screen.getByTestId('queue-table')).toHaveClass('aura-tbl--middle');
  });

  it('box fit: Submitted hides while the box is a narrow grid; AURA 5.60 wraps the text cells between words', async () => {
    render(await ChangeRequestQueueTable({ items: [item] }));
    const head = screen.getByRole('columnheader', { name: 'admin.changeRequests.queue.columns.submitted' });
    const row = screen.getByTestId('queue-row');
    const [memberCell, submitterCell, fieldsCell, submittedCell] = within(row).getAllByRole('cell');
    for (const el of [head, submittedCell]) {
      expect(el).toHaveClass('@min-[640px]/aura-tbl:@max-[900px]/aura-tbl:hidden');
    }
    expect(submittedCell).toHaveClass('is-nowrap');
    for (const el of [memberCell, submitterCell, fieldsCell]) expect(el!.className).not.toContain('overflow-wrap');
  });

  it('box fit: in the narrowest grid (640–720px box) the cells sit closer, so Review stays in view', async () => {
    render(await ChangeRequestQueueTable({ items: [item] }));
    const table = screen.getByTestId('queue-table');
    for (const row of within(table).getAllByRole('row')) {
      expect(row).toHaveClass(
        '@min-[640px]/aura-tbl:@max-[720px]/aura-tbl:[&>:not(:first-child)]:pl-[var(--aura-space-2)]',
        '@min-[640px]/aura-tbl:@max-[720px]/aura-tbl:[&>:not(:last-child)]:pr-[var(--aura-space-2)]',
      );
    }
  });

  it('keeps "Overdue" on the line of the waiting time', async () => {
    render(await ChangeRequestQueueTable({ items: [item] }));
    const badge = screen.getByTestId('overdue-badge');
    expect(badge.parentElement).toHaveClass('flex-nowrap');
    // only while the box is a narrow grid it sits below, on every row alike.
    expect(badge.parentElement).toHaveClass(
      '@min-[640px]/aura-tbl:@max-[900px]/aura-tbl:flex-col',
      '@min-[640px]/aura-tbl:@max-[900px]/aura-tbl:items-start',
    );
  });

  it('lays out the phone card with AURA’s card slots: the company as title, Review as action', async () => {
    // AURA 5.13 (#84): Td card="title" / "action" share the first line of a
    // stacked row and the other cells fall two to a line; no grid of our own.
    render(await ChangeRequestQueueTable({ items: [item] }));
    const cells = within(screen.getByTestId('queue-row')).getAllByRole('cell');
    expect(cells[0]).toHaveAttribute('data-card', 'title');
    expect(cells.at(-1)).toHaveAttribute('data-card', 'action');
    expect(cells.every((c) => !c.className.includes('aura-tbl:col-'))).toBe(true);
  });

  it('draws each phone card apart and framed with AURA’s own cards, Review at touch height (AURA #85, #100)', async () => {
    render(await ChangeRequestQueueTable({ items: [item] }));
    expect(screen.getByTestId('queue-table')).toHaveClass('aura-tbl--cards');
    const row = screen.getByTestId('queue-row');
    // no frame of our own on the row; its only reach into the table's box is
    // the narrowest-grid cell spacing (our column count), not a card style
    expect(row.className.replace(TIGHT_CELLS_IN_NARROWEST_GRID, '')).not.toContain('aura-tbl:');
    expect(within(row).getByRole('link')).toHaveClass('aura-btn--sm', 'aura-btn--touch');
  });
});


// The list card rule (docs/aura-adoption.md § List card): from 640px up the table
// runs edge to edge inside the card (AURA `bleed`, 5.27 #130), keeping its header band.
describe('change-request queue table in the list card', () => {
  it('bleeds to the card edges; a "Next" link can follow it, so it does not end the card', async () => {
    const { container } = render(await ChangeRequestQueueTable({ items: [item] }));
    expect(container.querySelector('.aura-bleed')).not.toBeNull();
    expect(container.querySelector('.aura-bleed-end')).toBeNull();
  });
});
