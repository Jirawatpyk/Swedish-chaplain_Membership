/**
 * Task 5 — pipeline row ⋯ menu offers "Mark paid" only for payable statuses.
 *
 * `MarkPaidOfflineDialog` is mocked to a marker: this test only pins the
 * menu-item VISIBILITY gate (mirrors `shouldOfferMarkPaid`), not the dialog
 * interaction itself (already covered by `cycle-admin-validation.test.ts` +
 * the E2E cancel/mark-paid spec — Base UI Dialog + React 19 `startTransition`
 * deadlocks under jsdom, the dialog-jsdom-hang memory). `next/navigation` is
 * mocked the same way as `pipeline-table.test.tsx` (RowActions calls
 * `useRouter()` unconditionally for the "Open" menu item).
 *
 * `vi.useRealTimers()` per-test: the global Vitest setup installs a fixed
 * fake clock, under which Base UI's floating-ui positioning (real
 * `setTimeout`) never resolves and `findByRole` spins to the test timeout
 * (see `user-menu.test.tsx` for the same override).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';
import type { PipelineRow } from '@/modules/renewals/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/app/(staff)/admin/renewals/_components/mark-paid-offline-dialog', () => ({
  MarkPaidOfflineDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mark-paid-dialog" /> : null,
}));

function row(status: PipelineRow['status']): PipelineRow {
  return {
    cycleId: 'c1' as PipelineRow['cycleId'],
    memberId: 'm1',
    companyName: 'Acme',
    tierBucket: 'regular' as PipelineRow['tierBucket'],
    expiresAt: '2026-09-01T00:00:00.000Z',
    urgency: 't-30',
    status,
    lastReminderAt: null,
    lastReminderStepId: null,
    linkedInvoiceId: null,
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  };
}

function renderTable(status: PipelineRow['status']) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PipelineTable rows={[row(status)]} canMutate />
    </NextIntlClientProvider>,
  );
}

describe('pipeline row — Mark paid affordance', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useFakeTimers();
  });

  it('shows "Mark paid" for a payable (awaiting_payment) row', async () => {
    renderTable('awaiting_payment');
    // Task 12 — the row's ⋯ trigger now also exists in `PipelineCardList`'s
    // (`md:hidden`) card for the SAME row; scope to the desktop `<table>`
    // (`hidden md:block`) so this keeps addressing the one it always did.
    // The resulting menu (Base UI Portal, only mounted while open) stays
    // unambiguous — the card list's own ⋯ trigger was never clicked.
    await userEvent.click(
      within(screen.getByRole('table')).getByRole('button', { name: /actions for/i }),
    );
    expect(await screen.findByRole('menuitem', { name: /mark paid/i })).toBeInTheDocument();
  });

  it('hides "Mark paid" for a terminal (completed) row', async () => {
    renderTable('completed');
    await userEvent.click(
      within(screen.getByRole('table')).getByRole('button', { name: /actions for/i }),
    );
    // "Open" survives on every status — wait for the menu to actually be
    // open before asserting the negative, so this can't pass on a menu that
    // silently failed to render.
    expect(await screen.findByRole('menuitem', { name: /open cycle/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /mark paid/i })).toBeNull();
  });
});
