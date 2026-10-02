/**
 * 122 US5a (US5a review, 29 Sep) — the queue's date range takes the tenant's
 * timezone, the same one the page turns ?from/?to into day bounds with
 * (`env.tenant.timezone`). They were hard-coded to Asia/Bangkok, so "today" in
 * the picker and the day the page filtered on could disagree for a tenant
 * outside Bangkok.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const seen = vi.hoisted(() => ({ timeZones: [] as unknown[] }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/change-requests',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@jirawatpyk/aura-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@jirawatpyk/aura-react')>();
  return {
    ...actual,
    FilterDateRange: (props: { timeZone?: string; label?: string }) => {
      seen.timeZones.push(props.timeZone);
      return <button type="button" aria-label={props.label} />;
    },
  };
});

const { ChangeRequestQueueFilters } = await import('@/app/(staff)/admin/change-requests/_components/queue-filters');

describe('queue date range', () => {
  it('uses the timezone the page passes, not a hard-coded Asia/Bangkok', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChangeRequestQueueFilters resultCount={0} hasMore={false} timeZone="Europe/Stockholm" />
      </NextIntlClientProvider>,
    );
    expect(seen.timeZones.length).toBeGreaterThanOrEqual(1);
    expect(new Set(seen.timeZones)).toEqual(new Set(['Europe/Stockholm']));
  });
});
