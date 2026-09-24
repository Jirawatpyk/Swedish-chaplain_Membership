/**
 * F119 T151 (research R18; the RED for T116) — a new-stage chip is offered
 * only when the approval round is switched on OR the tenant has at least one
 * row in that stage. Never offer a filter that can only return zero rows (the
 * module's own retired-status rule, `broadcast-status.ts`), and never hide a
 * stage an in-flight E-Blast is sitting in.
 *
 * The five stages that exist only because of migration 0305 are the gated
 * set; the eight pre-existing offered statuses are never gated.
 *
 * `next/navigation` is mocked per `queue-filters-grouping.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';
import {
  BROADCAST_STATUSES,
  OFFERED_BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const nav = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replaceMock }),
  usePathname: () => '/admin/broadcasts',
  useSearchParams: () => nav.searchParams.current,
}));

const GATED: readonly BroadcastStatus[] = [
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
  'expired_no_member_response',
];

function counts(overrides: Partial<Record<BroadcastStatus, number>> = {}): Record<BroadcastStatus, number> {
  return Object.fromEntries(BROADCAST_STATUSES.map((s) => [s, overrides[s] ?? 0])) as Record<BroadcastStatus, number>;
}

function renderFilters(props: {
  approvalRoundEnabled: boolean;
  stageCounts: Record<BroadcastStatus, number> | null;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueFilters memberOptions={[]} {...props} />
    </NextIntlClientProvider>,
  );
}

const offeredValues = () =>
  screen
    .getAllByRole('checkbox')
    .map((el) => (el as HTMLInputElement).value)
    .sort();

beforeEach(() => {
  nav.replaceMock.mockClear();
  nav.searchParams.current = new URLSearchParams();
});

describe('<QueueFilters> — new-stage chips follow "flag ON or rows exist" (T151, R18)', () => {
  it('flag off + zero rows → chip absent (all five new stages withheld, the eight existing ones offered)', () => {
    renderFilters({ approvalRoundEnabled: false, stageCounts: counts() });
    const values = offeredValues();
    for (const s of GATED) expect(values).not.toContain(s);
    expect(values).toEqual(
      OFFERED_BROADCAST_STATUSES.filter((s) => !GATED.includes(s)).slice().sort(),
    );
  });

  it('flag off + one row → chip present (only for the stage that has the row)', () => {
    renderFilters({ approvalRoundEnabled: false, stageCounts: counts({ changes_requested: 1 }) });
    const values = offeredValues();
    expect(values).toContain('changes_requested');
    for (const s of GATED.filter((g) => g !== 'changes_requested')) expect(values).not.toContain(s);
  });

  it('flag on + zero rows → every offered stage has its chip', () => {
    renderFilters({ approvalRoundEnabled: true, stageCounts: counts() });
    expect(offeredValues()).toEqual([...OFFERED_BROADCAST_STATUSES].sort());
  });

  it('flag off + zero rows, but the URL already filters on a new stage → that chip stays, checked, so it can be cleared', () => {
    nav.searchParams.current = new URLSearchParams('status=awaiting_member_approval');
    renderFilters({ approvalRoundEnabled: false, stageCounts: counts() });
    const chip = screen
      .getAllByRole('checkbox')
      .find((el) => (el as HTMLInputElement).value === 'awaiting_member_approval');
    expect(chip).toBeDefined();
    expect(chip).toBeChecked();
  });

  it('flag off + counts unreadable → the new-stage chips are offered (an in-flight row must never be hidden)', () => {
    renderFilters({ approvalRoundEnabled: false, stageCounts: null });
    expect(offeredValues()).toEqual([...OFFERED_BROADCAST_STATUSES].sort());
  });
});
