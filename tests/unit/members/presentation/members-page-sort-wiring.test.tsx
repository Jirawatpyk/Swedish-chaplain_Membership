/**
 * FIX-1 (055-member-number code review) — page-boundary sort wiring.
 *
 * Guards the regression where the /admin/members page boundary dropped
 * `?sort=memberNumber` (only `engagement` was allow-listed), leaving the
 * "Member No." column header a dead control: the URL + arrow + aria-sort
 * toggled but the rows never re-ordered because the value never reached
 * `directorySearchWithCount`.
 *
 * Two layers:
 *   (1) `parseDirectorySort` pure allow-list — accepts both sortable
 *       columns, rejects everything else.
 *   (2) End-to-end through `MembersDirectoryBody`: `?sort=memberNumber`
 *       is forwarded into the `directorySearchWithCount` call.
 *
 * FIX-D (code-review round-2) — exercise the page row-mapping with a
 * NON-EMPTY result: proves that `resolveMemberNumberPrefix` + `formatMemberNumber`
 * are wired correctly and the produced row carries the formatted display value.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Boundary mocks (the page is an async RSC; we invoke its data-fetching
// body directly and assert the search received the sort param). ------------

const directorySearchWithCount = vi.fn();
const resolveMemberNumberPrefixMock = vi.fn();
const loadMembersMembershipStatusMock = vi.fn();

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));

vi.mock('@/modules/members', () => ({
  directorySearchWithCount: (...args: unknown[]) =>
    directorySearchWithCount(...args),
  formatMemberNumber: (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`,
  resolveMemberNumberPrefix: (...args: unknown[]) =>
    resolveMemberNumberPrefixMock(...args),
  // `page.tsx` builds `VALID_STATUSES = new Set(MEMBER_STATUSES)` at module
  // load (since the 8bb1c476 server-const dedupe moved it into this barrel),
  // so the mock MUST provide it or the whole page module fails to evaluate.
  MEMBER_STATUSES: ['active', 'inactive', 'archived'] as const,
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: {}, memberSettings: {} }),
}));

vi.mock('@/modules/renewals', () => ({
  // Task 8 (#4) wired the member-directory page to a best-effort lapsed-
  // membership read. Stub it so this unit test never makes a real
  // deps/runInTenant DB call (which would hang the page render → 30s timeout).
  // Empty set → membership_lapsed:false on every row, leaving the sort-wiring +
  // member-number assertions unaffected. A module-level handle so the
  // degradation tests (S3) can make it reject / return !ok per-test.
  loadMembersMembershipStatus: (...args: unknown[]) =>
    loadMembersMembershipStatusMock(...args),
  // 067 #4 — page switched from makeRenewalsDeps to the lean
  // makeMembersMembershipStatusDeps factory (cyclesRepo + clock only).
  makeMembersMembershipStatusDeps: () => ({}),
}));

vi.mock('@/modules/plans', () => ({
  listPlans: vi.fn().mockResolvedValue({ ok: true, value: { data: [] } }),
}));

vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: () => ({
    tenant: { slug: 'test-tenant' },
    planRepo: {},
    taxPolicy: {},
    clock: {},
  }),
}));

vi.mock('@/modules/insights', () => ({
  projectEngagementScore: () => ({ score: null, band: null }),
}));

// next-intl server API + UI components are only referenced inside the
// returned JSX (createElement, not executed) — stub them to keep the
// import graph light and deterministic.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
}));

import { MembersDirectoryBody } from '@/app/(staff)/admin/members/page';
import { parseDirectorySort } from '@/app/(staff)/admin/members/page';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty result so the body returns early (before row-mapping).
  // Tests that need non-empty rows override this mock below.
  directorySearchWithCount.mockResolvedValue({
    ok: true,
    value: { items: [], total: 0 },
  });
  resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
  // Default: the lapsed/suspended-status read succeeds with both sets empty
  // (no badges). The S3 degradation tests override this per-test.
  loadMembersMembershipStatusMock.mockResolvedValue({
    ok: true,
    value: { lapsed: new Set(), suspended: new Set() },
  });
});

describe('parseDirectorySort — allow-list', () => {
  it('accepts memberNumber (the previously-dropped column)', () => {
    expect(parseDirectorySort('memberNumber')).toBe('memberNumber');
  });

  it('accepts engagement', () => {
    expect(parseDirectorySort('engagement')).toBe('engagement');
  });

  it('rejects unknown columns and undefined → default order', () => {
    expect(parseDirectorySort('company_name')).toBeUndefined();
    expect(parseDirectorySort('')).toBeUndefined();
    expect(parseDirectorySort(undefined)).toBeUndefined();
  });
});

describe('MembersDirectoryBody — forwards sort=memberNumber to the search', () => {
  it('passes sort: "memberNumber" + order into directorySearchWithCount', async () => {
    await MembersDirectoryBody({
      query: { sort: 'memberNumber', order: 'asc' },
      isAdmin: true,
    });

    expect(directorySearchWithCount).toHaveBeenCalledTimes(1);
    const passedInput = directorySearchWithCount.mock.calls[0]![1] as {
      sort?: string;
      order?: string;
    };
    expect(passedInput.sort).toBe('memberNumber');
    expect(passedInput.order).toBe('asc');
  });

  it('omits sort entirely for an unknown ?sort value (default recency order)', async () => {
    await MembersDirectoryBody({
      query: { sort: 'bogus' },
      isAdmin: true,
    });

    const passedInput = directorySearchWithCount.mock.calls[0]![1] as {
      sort?: string;
    };
    expect(passedInput.sort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FIX-D: exercise the row-mapping with a NON-EMPTY result so the
// resolveMemberNumberPrefix + formatMemberNumber wiring is covered.
// The empty-result path short-circuits before row-mapping, so
// FIX-6 row-mapping code was previously unreachable in this test.
// ---------------------------------------------------------------------------
describe('MembersDirectoryBody — row-mapping (FIX-D)', () => {
  it('produces a row with member_number_display from resolveMemberNumberPrefix + formatMemberNumber', async () => {
    // Arrange — non-empty result with one member row
    resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
    directorySearchWithCount.mockResolvedValue({
      ok: true,
      value: {
        total: 1,
        items: [
          {
            member: {
              memberId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
              memberNumber: 42,
              companyName: 'Alpha Corp',
              legalEntityType: 'limited',
              country: 'TH',
              planId: 'corporate',
              planYear: 2026,
              status: 'active',
              lastActivityAt: null,
              notes: null,
              tenantId: 'test-tenant',
            },
            planDisplayName: 'Corporate',
            primaryContact: null,
            riskScore: null,
            riskScoreBand: null,
          },
        ],
      },
    });

    // Act — invoke the RSC body function directly
    const result = await MembersDirectoryBody({
      query: { sort: 'memberNumber', order: 'asc' },
      isAdmin: true,
    });

    // Assert — resolveMemberNumberPrefix was called (wiring present)
    expect(resolveMemberNumberPrefixMock).toHaveBeenCalledTimes(1);

    // Assert — the JSX result tree contains the formatted display value.
    // MembersDirectoryBody returns a React element; the rows prop is passed to
    // DirectoryWithBulk → MembersTable. Rather than render the full tree
    // (which would need shadcn + next-intl in jsdom), we inspect the props
    // passed to the component that received the rows.
    //
    // The simplest, most stable assertion: stringify the React element tree
    // and confirm `SCCM-0042` appears in it (produced by the mocked
    // `formatMemberNumber('SCCM', 42) → 'SCCM-0042'`).
    const treeJson = JSON.stringify(result);
    expect(treeJson).toContain('SCCM-0042');
  });
});

// ---------------------------------------------------------------------------
// S3 (067 speckit-review) — the page-side best-effort catch around
// `loadMembersMembershipStatusSafe` degrades gracefully: when the lapsed-status
// read THROWS (or returns !ok), the directory STILL renders its rows; only the
// lapsed badges are suppressed. The use-case is typed Result<…, never>, but the
// page wraps it in try/catch precisely so a future throw on the directory hot
// path can never blank the whole table.
// ---------------------------------------------------------------------------
describe('MembersDirectoryBody — lapsed-status read degradation (S3)', () => {
  /** One member row so the row-mapping path is reached (not the empty early-out). */
  function seedOneRow(): void {
    resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
    directorySearchWithCount.mockResolvedValue({
      ok: true,
      value: {
        total: 1,
        items: [
          {
            member: {
              memberId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
              memberNumber: 42,
              companyName: 'Alpha Corp',
              legalEntityType: 'limited',
              country: 'TH',
              planId: 'corporate',
              planYear: 2026,
              status: 'active',
              lastActivityAt: null,
              notes: null,
              tenantId: 'test-tenant',
            },
            planDisplayName: 'Corporate',
            primaryContact: null,
            riskScore: null,
            riskScoreBand: null,
          },
        ],
      },
    });
  }

  it('lapsed read REJECTS → rows still render (badges suppressed, no throw)', async () => {
    seedOneRow();
    loadMembersMembershipStatusMock.mockRejectedValue(new Error('db down'));

    // The page must NOT propagate the rejection — it catches and degrades.
    const result = await MembersDirectoryBody({
      query: { sort: 'memberNumber', order: 'asc' },
      isAdmin: true,
    });

    // The directory still produced its row (proving the catch degraded rather
    // than blanking the table).
    expect(JSON.stringify(result)).toContain('SCCM-0042');
  });

  it('lapsed read returns {ok:false} → rows still render (badges suppressed)', async () => {
    seedOneRow();
    loadMembersMembershipStatusMock.mockResolvedValue({
      ok: false,
      error: { code: 'unexpected' },
    });

    const result = await MembersDirectoryBody({
      query: { sort: 'memberNumber', order: 'asc' },
      isAdmin: true,
    });

    expect(JSON.stringify(result)).toContain('SCCM-0042');
  });
});
