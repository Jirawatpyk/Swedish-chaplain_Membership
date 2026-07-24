/**
 * Task 6 (feat/members-portal-status) — page-boundary wiring for portal
 * state.
 *
 * `loadMembersPortalStatusSafe` (private to page.tsx) is the sole place that
 * catches a `loadMembersPortalStatus` throw. It MUST degrade to `null` — not
 * an empty `Map` — because the row mapper needs to tell "the read failed"
 * (→ 'unknown') apart from "this member has no primary contact" (→ null). An
 * empty Map would wrongly render every linked member as if their portal
 * state were simply absent, which the row mapper cannot distinguish from a
 * real answer.
 *
 * Mirrors the sibling `loadMembersMembershipStatusSafe` S3 degradation tests
 * in members-page-sort-wiring.test.tsx, but exercises the three-way
 * `portal_state` branch (null / 'unknown' / real PortalState) instead of the
 * two-way lapsed/suspended boolean sets.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const directorySearchWithCount = vi.fn();
const resolveMemberNumberPrefixMock = vi.fn();
const loadMembersMembershipStatusMock = vi.fn();
const loadMembersPortalStatusMock = vi.fn();

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
  loadMembersPortalStatus: (...args: unknown[]) =>
    loadMembersPortalStatusMock(...args),
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

import { MembersDirectoryBody } from '@/app/(staff)/admin/members/page';

const MEMBER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const LINKED_USER_ID = 'dddddddd-1111-4111-8111-dddddddddddd';

/** One member row with an optional linked primary contact. */
function seedOneRow(primaryContact: {
  linkedUserId: string | null;
} | null): void {
  resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
  directorySearchWithCount.mockResolvedValue({
    ok: true,
    value: {
      total: 1,
      items: [
        {
          member: {
            memberId: MEMBER_ID,
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
          primaryContact: primaryContact
            ? {
                contactId: 'cccccccc-1111-4111-8111-cccccccccccc',
                firstName: 'Jane',
                lastName: 'Smith',
                email: 'jane@example.com',
                inviteBouncedAt: null,
                linkedUserId: primaryContact.linkedUserId,
              }
            : null,
          riskScore: null,
          riskScoreBand: null,
        },
      ],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  loadMembersMembershipStatusMock.mockResolvedValue({
    ok: true,
    value: { lapsed: new Set(), suspended: new Set() },
  });
});

describe('MembersDirectoryBody — portal-status read degradation', () => {
  it('read THROWS → row still renders, portal_state degrades to "unknown" (never null-as-Map, never not_invited)', async () => {
    seedOneRow({ linkedUserId: LINKED_USER_ID });
    loadMembersPortalStatusMock.mockRejectedValue(new Error('db down'));

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    // The directory still produced its row (the catch degraded rather than
    // propagating the rejection and blanking the whole table).
    const treeJson = JSON.stringify(result);
    expect(treeJson).toContain('SCCM-0042');
    expect(treeJson).toContain('"portal_state":"unknown"');
    // The failure must never be misread as "not invited" — that would claim
    // a member still needs inviting when the read simply failed.
    expect(treeJson).not.toContain('"portal_state":"not_invited"');
  });

  it('read resolves {ok:false} → portal_state also degrades to "unknown"', async () => {
    seedOneRow({ linkedUserId: LINKED_USER_ID });
    loadMembersPortalStatusMock.mockResolvedValue({
      ok: false,
      error: { code: 'unexpected' },
    });

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    expect(JSON.stringify(result)).toContain('"portal_state":"unknown"');
  });

  it('read succeeds → portal_state carries the real PortalState value from the map', async () => {
    seedOneRow({ linkedUserId: LINKED_USER_ID });
    loadMembersPortalStatusMock.mockResolvedValue({
      ok: true,
      value: new Map([[MEMBER_ID, 'invite_expired']]),
    });

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    expect(JSON.stringify(result)).toContain('"portal_state":"invite_expired"');
  });

  it('member absent from a successful map → portal_state falls back to "unknown", not undefined', async () => {
    seedOneRow({ linkedUserId: LINKED_USER_ID });
    loadMembersPortalStatusMock.mockResolvedValue({
      ok: true,
      value: new Map(), // succeeded, but this member id is missing
    });

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    expect(JSON.stringify(result)).toContain('"portal_state":"unknown"');
  });

  it('member has no primary contact → portal_state is null, even when the read fails', async () => {
    seedOneRow(null);
    loadMembersPortalStatusMock.mockRejectedValue(new Error('db down'));

    const result = await MembersDirectoryBody({ query: {}, isAdmin: true });

    // null (no primary contact) must never be conflated with 'unknown'
    // (read failed) — they mean different things to the (Task 7) renderer.
    expect(JSON.stringify(result)).toContain('"portal_state":null');
    expect(JSON.stringify(result)).not.toContain('"portal_state":"unknown"');
  });
});
