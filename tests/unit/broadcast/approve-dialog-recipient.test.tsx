/**
 * Task 6 (2026-08-01-broadcast-review-queue-pr1) — single-approve dialog
 * shows the recipient count so an admin sees who a broadcast reaches
 * before approving. `recipientCount` is an optional prop threaded from
 * `EnrichedQueueRow` through `ReviewActions` into `ApproveDialog`;
 * absent it, the dialog renders exactly as before (no recipient line).
 *
 * `ApproveDialog` calls `useRouter()` (unused on this path, but required
 * at module scope) — established idiom:
 * tests/unit/app/admin/renewals/tier-upgrade-queue.test.tsx:21-23.
 *
 * Rendered under a real `NextIntlClientProvider` backed by canonical
 * `en.json` so the ICU-plural `recipientCount` key is exercised for
 * real, not an echo mock.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ApproveDialog } from '@/components/broadcast/admin/approve-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

afterEach(cleanup);

describe('ApproveDialog recipient count', () => {
  it('shows the recipient count when provided', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} recipientCount={12} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/Reaches ~12 recipients/)).toBeInTheDocument();
  });

  it('omits the recipient line when recipientCount is not provided', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ApproveDialog broadcastId="b1" open onOpenChange={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/Reaches ~/)).not.toBeInTheDocument();
  });
});
