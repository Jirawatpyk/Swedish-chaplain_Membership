/**
 * R4-T1 (2026-05-18 /speckit-review Round 4) — unit test for the
 * R3-F1 client-side paymentStatus URL guard in `AttendeeTable`.
 *
 * The component reads `searchParams.get('paymentStatus')`. If the
 * URL value is non-empty AND fails `isPaymentStatus()`, the
 * component:
 *   1. Fires `toast.info(t('paymentStatusFilterDropped'))` (R4-U1).
 *   2. Calls `router.replace()` with a URL stripped of
 *      `paymentStatus` + `page`.
 *   3. On `router.replace` rejection, falls back to `console.warn`
 *      without an infinite loop (R4-C1).
 *
 * The R4-C1 fix also switched the useEffect dep from
 * `[searchParams]` (object identity → changes every render) to
 * `[rawPaymentStatus]` (scalar value → stable). This test pins
 * the "at most one router.replace per scalar value change"
 * contract by re-rendering with the SAME searchParams object and
 * asserting no additional fires.
 *
 * Mocks next/navigation + sonner + Server-Component-only imports.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// MOCKS — factory closures over STABLE vi.fn() instances so every
// `useRouter()` invocation returns the same `{ push, replace }`
// pair (assertions can reach those mocks across re-renders).
vi.mock('next/navigation', () => {
  const push = vi.fn();
  const replace = vi.fn();
  const router = { push, replace };
  return {
    useRouter: () => router,
    usePathname: () => '/admin/events/abc-event/attendees',
    useSearchParams: () => globalThis.__testSearchParams as URLSearchParams,
  };
});

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AttendeeTable } from '@/components/events/attendee-table';
import { asEventId } from '@/modules/events/domain/branded-types';

declare global {
  var __testSearchParams: URLSearchParams;
}

const MESSAGES = {
  admin: {
    events: {
      detail: {
        attendees: {
          searchPlaceholder: 'Search…',
          searchLabel: 'Search attendees',
          searchSubmit: 'Search',
          showUnmatchedOnly: 'Show unmatched only',
          showUnmatchedOnlyActive: 'Showing unmatched',
          filterByPaymentStatusLabel: 'Filter by payment status',
          allPaymentStatuses: 'All statuses',
          empty: 'Empty',
          emptyHeading: 'No matches',
          clearFilters: 'Clear filters',
          filtersCleared: 'Filters cleared',
          paymentStatusFilterDropped:
            'The payment status filter wasn’t recognised — showing all statuses.',
          resultCount: '{count} rows',
          tableCaption: 'Attendees',
          copyEmailSuccess: 'Copied',
          copyEmailFailed: 'Copy failed',
          relinkAction: 'Relink',
          actionsHeader: 'Actions',
          pseudonymisedDisallowed: 'PII purged',
          columns: {
            attendee: 'Attendee',
            match: 'Match',
            ticket: 'Ticket',
            quota: 'Quota',
            registered: 'Registered',
          },
        },
      },
      paymentStatus: {
        paid: 'Paid',
        pending: 'Pending',
        refunded: 'Refunded',
        free: 'Free',
        waitlisted: 'Waitlisted',
        no_show: 'No show',
      },
      matchType: {
        member_contact: 'Member',
        member_domain: 'Member',
        member_fuzzy: 'Member',
        non_member: 'Non-member',
        unmatched: 'Unmatched',
      },
      matchTypeTooltip: {
        member_contact: '',
        member_domain: '',
        member_fuzzy: '',
        non_member: '',
        unmatched: '',
      },
      quotaEffect: {
        partnership: 'Partner',
        cultural: 'Cultural',
        overQuota: 'Over',
      },
      quotaEffectTooltip: {
        partnership: '',
        cultural: '',
        overQuota: '',
      },
    },
  },
};

function renderTable(searchParams: URLSearchParams) {
  globalThis.__testSearchParams = searchParams;
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      <AttendeeTable
        rows={[]}
        unmatchedOnly={false}
        initialSearch=""
        eventId={asEventId('00000000-0000-4000-8000-000000000001')}
        canRelink={false}
      />
    </NextIntlClientProvider>,
  );
}

describe('R4-T1 — AttendeeTable R3-F1 paymentStatus URL guard', () => {
  // Stable references — the mocked factories return the same vi.fn
  // instances on every call (closures in vi.mock factory).
  const toastInfo = toast.info as ReturnType<typeof vi.fn>;
  const router = useRouter();
  const routerReplace = router.replace as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.__testSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
  });

  it('fires toast.info AND router.replace on first render with invalid paymentStatus', () => {
    renderTable(new URLSearchParams('paymentStatus=junk'));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledTimes(1);
    const replaceUrl = routerReplace.mock.calls[0]?.[0] as string;
    expect(replaceUrl).not.toContain('paymentStatus');
    expect(replaceUrl).not.toContain('page');
  });

  it('does NOT fire for valid paymentStatus', () => {
    renderTable(new URLSearchParams('paymentStatus=paid'));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('does NOT fire when paymentStatus is absent', () => {
    renderTable(new URLSearchParams(''));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('does NOT fire when paymentStatus is empty string', () => {
    renderTable(new URLSearchParams('paymentStatus='));
    expect(toastInfo).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('falls back to console.warn (no infinite loop) when router.replace throws', () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    routerReplace.mockImplementationOnce(() => {
      throw new Error('synthetic nav rejection');
    });
    renderTable(new URLSearchParams('paymentStatus=junk'));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'router.replace to strip invalid paymentStatus failed',
      ),
      expect.any(Error),
    );
    consoleWarnSpy.mockRestore();
  });

  it('R4-C1 regression: re-render with same scalar value does NOT re-fire router.replace', () => {
    // Pre-R4-C1 the dep was `[searchParams]` (object identity changes
    // every render) → effect re-fired. Post-R4-C1 the dep is
    // `[rawPaymentStatus]` (scalar value, stable) → effect fires once.
    const sp = new URLSearchParams('paymentStatus=junk');
    const { rerender } = renderTable(sp);
    expect(routerReplace).toHaveBeenCalledTimes(1);
    // Re-render with a NEW URLSearchParams instance carrying the SAME
    // value — scalar dep should not re-fire the effect.
    act(() => {
      globalThis.__testSearchParams = new URLSearchParams('paymentStatus=junk');
      rerender(
        <NextIntlClientProvider locale="en" messages={MESSAGES}>
          <AttendeeTable
            rows={[]}
            unmatchedOnly={false}
            initialSearch=""
            eventId={asEventId('00000000-0000-4000-8000-000000000001')}
            canRelink={false}
          />
        </NextIntlClientProvider>,
      );
    });
    expect(routerReplace).toHaveBeenCalledTimes(1);
  });
});
