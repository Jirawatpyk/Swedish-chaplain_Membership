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
  it('shows the Actions column head; the member cell carries no card label; the row is centred', async () => {
    render(await ChangeRequestQueueTable({ items: [item] }));
    const head = screen.getByRole('columnheader', { name: 'admin.changeRequests.queue.columns.actions' });
    expect(head.querySelector('.sr-only')).toBeNull();
    const row = screen.getByTestId('queue-row');
    const [memberCell] = within(row).getAllByRole('cell');
    expect(memberCell).not.toHaveAttribute('data-label');
    expect(screen.getByTestId('queue-table').closest('[data-queue]')).toHaveAttribute('data-queue', 'board');
  });

  it('keeps "Overdue" on the line of the waiting time', async () => {
    render(await ChangeRequestQueueTable({ items: [item] }));
    const badge = screen.getByTestId('overdue-badge');
    expect(badge.parentElement).toHaveClass('flex-nowrap');
  });
});
