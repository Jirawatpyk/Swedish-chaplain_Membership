/**
 * #89 (UX L9/L10 on #777) — the E-Blast queue's Member filter never claims
 * "All members" while the queue is filtered:
 * - an archived member it holds (only ever the selected one) reads
 *   "{company} (archived)";
 * - an uppercase `?memberId=` matches its option (the server lowercases it);
 * - a well-formed id that matches no member shows "Unknown member";
 * - a malformed id is ignored by the server, so the filter shows "All members".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { QueueFilters } from '@/components/broadcast/admin/queue-filters';
import { BROADCAST_STATUSES, type BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const nav = vi.hoisted(() => ({ searchParams: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/broadcasts',
  useSearchParams: () => nav.searchParams.current,
}));

const ZERO = Object.fromEntries(BROADCAST_STATUSES.map((s) => [s, 0])) as Record<BroadcastStatus, number>;
const ACME = '3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b';
const OLD = '9b1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const NOBODY = '11111111-2222-4333-8444-555555555555';
const f = enMessages.admin.broadcasts.queue.filters;

function show(query: string) {
  nav.searchParams.current = new URLSearchParams(query);
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <QueueFilters
        timeZone="Asia/Bangkok"
        memberOptions={[
          { memberId: ACME, displayName: 'Acme Co.', archived: false },
          { memberId: OLD, displayName: 'Old Co.', archived: true },
        ]}
        stageCounts={ZERO}
        approvalRoundEnabled={false}
      />
    </NextIntlClientProvider>,
  );
  // AURA's FilterSelect face: "{label} {chosen option}".
  const face = screen.getByRole('combobox', { name: new RegExp(`^${f.memberLabel}`) }).textContent ?? '';
  expect(face.startsWith(f.memberLabel)).toBe(true);
  return face.slice(f.memberLabel.length);
}

beforeEach(() => vi.useRealTimers());
afterEach(cleanup);

describe('E-Blast queue Member filter labels (#89)', () => {
  it('labels the archived member it filters by', () => {
    expect(show(`memberId=${OLD}`)).toBe('Old Co. (archived)');
  });

  it('matches an uppercase memberId to its option', () => {
    expect(show(`memberId=${ACME.toUpperCase()}`)).toBe('Acme Co.');
  });

  it('shows "Unknown member" for a well-formed id that matches no member', () => {
    expect(show(`memberId=${NOBODY}`)).toBe(f.memberUnknown);
  });

  it('shows "All members" for a malformed id (the server ignores it)', () => {
    expect(show('memberId=not-a-uuid')).toBe(f.memberAll);
  });
});
