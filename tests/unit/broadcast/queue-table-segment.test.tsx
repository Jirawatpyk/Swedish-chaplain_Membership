/**
 * Task 4 (2026-08-01-broadcast-review-queue-pr1) — Audience column must
 * show the localised segment label, not the raw `segmentType` enum
 * (`event_attendees_last_90d`, `all_members`, `tier`, `custom`).
 *
 * `QueueTable` is an async Server Component — resolve it first
 * (`await QueueTable({...})`) and render the returned element, per
 * tests/unit/app/admin/members/benefits-page-suspended-badge.test.tsx:19-35.
 * This test asserts the actual COPY (not just structure), so an echo `t()`
 * mock is not enough — `getTranslations` is mocked to return a real
 * next-intl translator (`createTranslator`) backed by the canonical
 * `en.json` messages, scoped to whichever namespace the component asks for.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) =>
    createTranslator({
      locale: 'en',
      messages: enMessages,
      namespace: ns,
    } as unknown as Parameters<typeof createTranslator>[0]),
  ),
  getLocale: vi.fn(async () => 'en'),
}));

// `QueueTableClient` calls `useRouter()` (for `router.refresh()` after a
// bulk-approve action) — it needs a mounted app router in the test render.
// Established idiom: tests/unit/app/admin/renewals/tier-upgrade-queue.test.tsx:21-23.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { QueueTable, type QueueRow } from '@/components/broadcast/admin/queue-table';

const row: QueueRow = {
  broadcastId: 'b1',
  status: 'submitted',
  subject: 'Hello',
  requestedByMemberId: 'm1',
  requestedByMemberDisplayName: 'Acme Co',
  actorRole: 'member_self_service',
  segmentType: 'event_attendees_last_90d',
  estimatedRecipientCount: 12,
  submittedAt: '2026-08-01T00:00:00.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
};

afterEach(cleanup);

describe('QueueTable — Audience column segment label (Task 4)', () => {
  it('renders the localised segment label, not the raw enum', async () => {
    const ui = await QueueTable({ rows: [row], readOnly: false });
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {ui}
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('Event attendees (last 90 days)')).toBeInTheDocument();
    expect(screen.queryByText('event_attendees_last_90d')).not.toBeInTheDocument();
  });
});
