/**
 * Task 10 (feat/members-portal-status) — needs-invite chip COUNT wiring.
 *
 * Two contracts:
 *   (1) `parsePortalFilter` — pure allow-list, mirrors `parseDirectorySort`:
 *       only 'needs_invite' is honoured; any other value (including near-miss
 *       typos/casing) must NOT count as an active filter — otherwise
 *       `?portal=xyz` would render the "filtered to zero" empty state on a
 *       full directory.
 *   (2) `countMembersNeedingPortalInviteSafe` (private to page.tsx) — the
 *       sole place that catches a `countMembersNeedingPortalInvite` throw or
 *       `!ok` result. MUST degrade to `null`, never `0`: an absent chip count
 *       means "everyone invited" (D5), so `0` after a failed read would
 *       falsely tell the operator the work is done while members are still
 *       waiting to be invited.
 *
 * Also guards the placement crux (design D7 + the Task 10 brief): the count
 * is computed in the FIRST `Promise.all`, before either early return, so
 * `portalInviteCount` must reach `<DirectoryFilters>` in the error branch and
 * the zero-rows branch — not only the normal-render branch.
 *
 * Mirrors members-page-portal-status-wiring.test.tsx / members-page-sort-
 * wiring.test.tsx's mock-and-invoke pattern: `MembersDirectoryBody` is
 * invoked directly (the async RSC data-fetching body) and the returned React
 * element tree is JSON-serialised so the `portalInviteCount` prop threaded to
 * `<DirectoryFilters>` can be asserted without a DOM render.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const directorySearchWithCount = vi.fn();
const resolveMemberNumberPrefixMock = vi.fn();
const loadMembersMembershipStatusMock = vi.fn();
const countMembersNeedingPortalInviteMock = vi.fn();

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));

vi.mock('@/modules/members', () => ({
  directorySearchWithCount: (...args: unknown[]) =>
    directorySearchWithCount(...args),
  formatMemberNumber: (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(4, '0')}`,
  resolveMemberNumberPrefix: (...args: unknown[]) =>
    resolveMemberNumberPrefixMock(...args),
  // page.tsx also imports loadMembersPortalStatus; none of these tests
  // exercise the badge read so it is left unmocked (undefined) — the
  // page's own try/catch degrades it to `null` (portal badges suppressed),
  // exactly like an unmocked countMembersNeedingPortalInvite call would.
  countMembersNeedingPortalInvite: (...args: unknown[]) =>
    countMembersNeedingPortalInviteMock(...args),
  MEMBER_STATUSES: ['active', 'inactive', 'archived'] as const,
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: {}, memberSettings: {} }),
}));

vi.mock('@/modules/renewals', () => ({
  loadMembersMembershipStatus: (...args: unknown[]) =>
    loadMembersMembershipStatusMock(...args),
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

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
}));

import {
  MembersDirectoryBody,
  parsePortalFilter,
} from '@/app/(staff)/admin/members/page';

beforeEach(() => {
  vi.clearAllMocks();
  resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
  loadMembersMembershipStatusMock.mockResolvedValue({
    ok: true,
    value: { lapsed: new Set(), suspended: new Set() },
  });
});

function seedZeroRows(): void {
  directorySearchWithCount.mockResolvedValue({
    ok: true,
    value: { total: 0, items: [] },
  });
}

function seedSearchError(): void {
  directorySearchWithCount.mockResolvedValue({
    ok: false,
    error: { type: 'server_error', message: 'db down' },
  });
}

describe('parsePortalFilter — allow-list', () => {
  it('honours only the literal "needs_invite"', () => {
    expect(parsePortalFilter('needs_invite')).toBe(true);
  });

  it('rejects any other value, absence, and near-miss casing/typos', () => {
    expect(parsePortalFilter(undefined)).toBe(false);
    expect(parsePortalFilter('')).toBe(false);
    expect(parsePortalFilter('all')).toBe(false);
    expect(parsePortalFilter('needs-invite')).toBe(false);
    expect(parsePortalFilter('NEEDS_INVITE')).toBe(false);
    expect(parsePortalFilter('xyz')).toBe(false);
  });
});

describe('MembersDirectoryBody — needs-invite chip count degrade path', () => {
  it('countMembersNeedingPortalInvite THROWS → portalInviteCount degrades to null, never 0', async () => {
    seedZeroRows();
    countMembersNeedingPortalInviteMock.mockRejectedValue(
      new Error('db down'),
    );

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });
    const treeJson = JSON.stringify(result);

    expect(treeJson).toContain('"portalInviteCount":null');
    // The failure must never be misread as "zero members need inviting" —
    // that would tell the operator the work is done while the read simply
    // failed.
    expect(treeJson).not.toContain('"portalInviteCount":0');
  });

  it('countMembersNeedingPortalInvite resolves {ok:false} → portalInviteCount also degrades to null', async () => {
    seedZeroRows();
    countMembersNeedingPortalInviteMock.mockResolvedValue({
      ok: false,
      error: { code: 'unexpected' },
    });

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    expect(JSON.stringify(result)).toContain('"portalInviteCount":null');
  });

  it('countMembersNeedingPortalInvite succeeds → the real count reaches DirectoryFilters', async () => {
    seedZeroRows();
    countMembersNeedingPortalInviteMock.mockResolvedValue({
      ok: true,
      value: 12,
    });

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    expect(JSON.stringify(result)).toContain('"portalInviteCount":12');
  });

  it('directory search itself FAILS → portalInviteCount still reaches DirectoryFilters (computed before the early return)', async () => {
    seedSearchError();
    countMembersNeedingPortalInviteMock.mockResolvedValue({
      ok: true,
      value: 7,
    });

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    expect(JSON.stringify(result)).toContain('"portalInviteCount":7');
  });
});

describe('MembersDirectoryBody — ?portal=needs_invite reaches the search filter', () => {
  it('forwards portalNeedsInvite:{now} into directorySearchWithCount only when the param is the exact allow-listed value', async () => {
    seedZeroRows();
    countMembersNeedingPortalInviteMock.mockResolvedValue({
      ok: true,
      value: 3,
    });

    await MembersDirectoryBody({
      query: { portal: 'needs_invite' },
      isAdmin: true,
    });

    expect(directorySearchWithCount).toHaveBeenCalledTimes(1);
    const passedInput = directorySearchWithCount.mock.calls[0]![1] as {
      portalNeedsInvite?: { now: Date };
    };
    expect(passedInput.portalNeedsInvite?.now).toBeInstanceOf(Date);
  });

  it('an unrecognised ?portal= value is NOT forwarded to the search', async () => {
    seedZeroRows();
    countMembersNeedingPortalInviteMock.mockResolvedValue({
      ok: true,
      value: 0,
    });

    await MembersDirectoryBody({
      query: { portal: 'xyz' },
      isAdmin: true,
    });

    const passedInput = directorySearchWithCount.mock.calls[0]![1] as {
      portalNeedsInvite?: unknown;
    };
    expect(passedInput.portalNeedsInvite).toBeUndefined();
  });

  it('the count use case ALWAYS receives portalNeedsInvite:{now}, even when the param is absent (D7 — count is always scoped)', async () => {
    seedZeroRows();
    countMembersNeedingPortalInviteMock.mockResolvedValue({
      ok: true,
      value: 0,
    });

    await MembersDirectoryBody({ query: {}, isAdmin: true });

    expect(countMembersNeedingPortalInviteMock).toHaveBeenCalledTimes(1);
    const [, passedFilter] = countMembersNeedingPortalInviteMock.mock
      .calls[0] as [unknown, { portalNeedsInvite?: { now: Date } }];
    expect(passedFilter.portalNeedsInvite?.now).toBeInstanceOf(Date);
  });
});
