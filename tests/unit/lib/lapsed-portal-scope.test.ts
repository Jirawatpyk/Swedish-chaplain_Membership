/**
 * 059-membership-suspension Task 3 — `checkPortalAccess` spec.
 *
 * Repoints the pre-existing F8 Phase 5 Wave C spec (`checkLapsedPortalScope`,
 * mocked via the never-returns-lapsed `findActiveForMember`) onto the new
 * two-policy resolver, mocked via `findLatestCycleForMember` — which, unlike
 * `findActiveForMember`, DOES return a cycle in `lapsed` status. That is the
 * whole point of Task 2/3: a lapsed cycle is no longer invisible to the
 * portal gate.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkPortalAccess,
  isPortalPathAllowed,
  isTerminatedAllowedRoute,
  LAPSED_PORTAL_ALLOWED_PREFIXES,
} from '@/lib/lapsed-portal-scope';
import type { PortalAccessDeps } from '@/lib/lapsed-portal-scope';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { buildCycle as buildCycleShared } from '../renewals/_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_ID = 'mem-133';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1330';
const FIXED_NOW = new Date('2026-07-14T12:00:00Z');

function buildCycle(overrides: Record<string, unknown> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_ID,
    status: 'lapsed',
    expiresAt: '2026-01-01T00:00:00Z', // in the past relative to FIXED_NOW → terminated
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  findImpl?: () => Promise<RenewalCycle | null>;
  emitImpl?: () => Promise<void>;
  now?: Date;
}): {
  deps: PortalAccessDeps;
  emitMock: ReturnType<typeof vi.fn>;
  findMock: ReturnType<typeof vi.fn>;
} {
  const findMock = vi.fn(args.findImpl ?? (async () => args.cycle ?? null));
  const emitMock = vi.fn(args.emitImpl ?? (async () => {}));
  const deps: PortalAccessDeps = {
    cyclesRepo: { findLatestCycleForMember: findMock as never },
    auditEmitter: { emit: emitMock as never },
    clock: { now: () => args.now ?? FIXED_NOW },
  };
  return { deps, emitMock, findMock };
}

const baseCtx = {
  tenantId: TENANT_ID,
  memberId: MEMBER_ID,
  actorUserId: 'user-1',
  correlationId: 'corr-1',
};

describe('checkPortalAccess — terminated policy (deny-by-default)', () => {
  it('whitelisted /portal/renewal/* → allowed (route_whitelisted)', async () => {
    const cycle = buildCycle();
    const { deps, findMock } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/renewal/abc',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('route_whitelisted');
    expect(findMock).toHaveBeenCalledWith(TENANT_ID, MEMBER_ID);
  });

  it('whitelisted /portal/preferences/renewals → allowed', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/preferences/renewals',
    });
    expect(r.allowed).toBe(true);
  });

  it('whitelisted /api/portal/renewal/* → allowed', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/api/portal/renewal/abc/confirm',
    });
    expect(r.allowed).toBe(true);
  });

  it('bare /portal dashboard → allowed (exact-match, not a swallow-all prefix)', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('route_whitelisted');
  });

  it('non-whitelisted + terminated cycle (lapsed, expired) → blocked + emits audit', async () => {
    const cycle = buildCycle();
    const { deps, emitMock } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe('terminated_route_blocked');
      expect(r.cycleId).toBe(cycle.cycleId);
    }
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_action_blocked',
      payload: { blocked_route: '/portal/dashboard' },
    });
  });

  it('audit emit failure does not mask the blocked decision', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(false);
  });

  it('cancelled + expired is ALSO terminated (not just lapsed)', async () => {
    const cycle = buildCycle({ status: 'cancelled', closedReason: 'admin_marked' });
    const { deps } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(false);
  });
});

describe('checkPortalAccess — full access (no cycle / good standing)', () => {
  it('no cycle at all → allowed (full), no audit emitted', async () => {
    const { deps, emitMock } = fakeDeps({ cycle: null });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('full');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('lapsed with a FUTURE expiresAt → STILL terminated (065 §5.2 — no grace restore)', async () => {
    // Regression pin for 065 §5.2⇄§5.3 (see deriveMembershipAccess docstring):
    // a `lapsed` cycle is terminated regardless of `expiresAt`. A member born
    // `awaiting_payment` and lapsed at due+60 carries a far-future `expiresAt`;
    // the REMOVED "expiresAt < now" grace gate would have wrongly restored FULL
    // access. This used to be a full-access case (hence its place in this
    // block) — post-065 it asserts the corrected terminated behavior, and
    // `/portal/dashboard` is not on the terminated allowlist → blocked.
    const cycle = buildCycle({ expiresAt: '2027-01-01T00:00:00Z' }); // future vs FIXED_NOW; status defaults to 'lapsed'
    const { deps } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toBe('terminated_route_blocked');
  });

  it('completed cycle → allowed (full)', async () => {
    const cycle = buildCycle({
      status: 'completed',
      closedAt: '2026-06-01T00:00:00Z',
      closedReason: null,
      linkedInvoiceId: 'inv-1',
    });
    const { deps } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/dashboard',
    });
    expect(r.allowed).toBe(true);
  });
});

describe('checkPortalAccess — suspended policy (allow-by-default)', () => {
  it('awaiting_payment + non-denylisted route → allowed (suspended_route_allowed)', async () => {
    const cycle = buildCycle({ status: 'awaiting_payment', closedAt: null, closedReason: null });
    const { deps } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/invoices/abc',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('suspended_route_allowed');
  });

  it('awaiting_payment + denylisted /portal/broadcasts/new → blocked + emits membership_suspended_action_blocked (Task 8: discriminated from the terminated event)', async () => {
    const cycle = buildCycle({ status: 'awaiting_payment', closedAt: null, closedReason: null });
    const { deps, emitMock } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/broadcasts/new',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe('suspended_route_blocked');
      expect(r.cycleId).toBe(cycle.cycleId);
    }
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'membership_suspended_action_blocked',
      payload: {
        cycle_id: cycle.cycleId,
        member_id: MEMBER_ID,
        blocked_route: '/portal/broadcasts/new',
        access_state: 'suspended',
      },
    });
  });

  it('pending_admin_reactivation → suspended (allowed on ordinary routes)', async () => {
    const cycle = buildCycle({
      status: 'pending_admin_reactivation',
      closedAt: null,
      closedReason: null,
      enteredPendingAt: '2026-07-01T00:00:00Z',
    });
    const { deps } = fakeDeps({ cycle });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/invoices/abc',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('suspended_route_allowed');
  });
});

describe('checkPortalAccess — fail-open on read error', () => {
  it('cyclesRepo throws → allowed (fail_open) + emits membership_access_fail_open (Task 8)', async () => {
    const { deps, emitMock } = fakeDeps({
      findImpl: async () => {
        throw new Error('connection reset');
      },
    });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/broadcasts/new',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('fail_open');
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'membership_access_fail_open',
      payload: {
        member_id: MEMBER_ID,
        blocked_route: '/portal/broadcasts/new',
        error: 'connection reset',
      },
    });
  });

  it('fail-open audit emit failure does not mask the fail-open decision (fire-and-forget)', async () => {
    const { deps } = fakeDeps({
      findImpl: async () => {
        throw new Error('connection reset');
      },
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: '/portal/broadcasts/new',
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('fail_open');
  });
});

describe('isTerminatedAllowedRoute (route-matching table)', () => {
  it.each([
    ['/portal', true],
    ['/portal?tab=account', true],
    ['/portal/renewal/abc', true],
    ['/portal/renewal/abc/success', true],
    ['/portal/preferences/renewals', true],
    ['/api/portal/renewal/abc/confirm', true],
    ['/portal/dashboard', false],
    ['/portal/timeline', false],
    ['/portal/billing', false],
    ['/portal/broadcasts', false],
    ['/api/portal/billing', false],
    // The hardened `matchesScopePrefix` requires the next char to be `/` or
    // `?` (or the strings be equal), so confusable substrings are rejected.
    ['/portal/renewal-evil', false],
    ['/portal/renewal-admin/foo', false],
    ['/portal/preferences-other', false],
    ['/api/portal/preferences/renewals?next=/x', true],
    ['/portal/renewal', true],
    ['/portal/renewal?cycle=1', true],
    ['/portal/account', true],
    ['/portal/account/data-export', true],
    // Precision: a confusable substring like /portal/account-settings must
    // NOT match the /portal/account prefix.
    ['/portal/account-settings', false],
  ])('isTerminatedAllowedRoute(%s) === %s', (path, expected) => {
    expect(isTerminatedAllowedRoute(path)).toBe(expected);
  });

  it('LAPSED_PORTAL_ALLOWED_PREFIXES is non-empty', () => {
    expect(LAPSED_PORTAL_ALLOWED_PREFIXES.length).toBeGreaterThan(0);
  });
});

/**
 * F119 T074 (spec § Edge Cases) — a lapsed member may still OPEN their own
 * E-Blast and DECIDE on a pending version (approve, request changes, withdraw)
 * or cancel it: reading and deciding are not benefit actions. The exemption is
 * EXACT-PATH, anchored on a UUID `[id]` segment, so every benefit-consuming
 * sibling under `/api/broadcasts/**` stays refused.
 */
describe('isTerminatedAllowedRoute — the F119 E-Blast sign-off exemption (T074)', () => {
  const ID = '0f3c9a2e-5b1d-4c7e-9a8b-2d4e6f8a0b1c';

  it.each([
    [`/api/broadcasts/${ID}/decision`, true],
    [`/api/broadcasts/${ID}/cancel`, true],
    [`/api/broadcasts/${ID}`, true],
    [`/api/broadcasts/${ID}/versions`, true],
    [`/portal/broadcasts/${ID}`, true],
    [`/portal/broadcasts/${ID}?from=email`, true],
    [`/api/broadcasts/${ID.toUpperCase()}/decision`, true],
    // Benefit-consuming siblings stay refused.
    ['/api/broadcasts/submit', false],
    ['/api/broadcasts/inline-image-upload', false],
    ['/api/broadcasts/preview', false],
    ['/api/broadcasts/test-copy', false],
    ['/api/broadcasts/quota', false],
    ['/api/broadcasts/recipient-count', false],
    ['/api/broadcasts/draft', false],
    [`/api/broadcasts/draft/${ID}`, false],
    [`/api/broadcasts/templates/${ID}/started`, false],
    ['/portal/broadcasts/new', false],
    ['/portal/broadcasts', false],
    // Anchoring: a non-UUID segment, a trailing segment, a suffix, a prefix.
    ['/api/broadcasts/not-a-uuid/decision', false],
    [`/api/broadcasts/${ID}/decision/extra`, false],
    [`/api/broadcasts/${ID}/decision-evil`, false],
    [`/api/broadcasts/${ID}x/decision`, false],
    [`/api/broadcasts/${ID}/images`, false],
    [`/x/api/broadcasts/${ID}/decision`, false],
    [`/portal/broadcasts/${ID}/edit`, false],
  ])('isTerminatedAllowedRoute(%s) === %s', (path, expected) => {
    expect(isTerminatedAllowedRoute(path)).toBe(expected);
  });

  it("a lapsed member's decision POST passes the gate; their submit is still refused and audited", async () => {
    const { deps, emitMock } = fakeDeps({ cycle: buildCycle() });
    const decision = await checkPortalAccess(deps, {
      ...baseCtx,
      pathname: `/api/broadcasts/${ID}/decision`,
      action: 'POST',
    });
    expect(decision).toEqual({ allowed: true, reason: 'route_whitelisted' });
    expect(emitMock).not.toHaveBeenCalled();

    const submit = await checkPortalAccess(deps, { ...baseCtx, pathname: '/api/broadcasts/submit', action: 'POST' });
    expect(submit.allowed).toBe(false);
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_action_blocked',
      payload: { blocked_route: '/api/broadcasts/submit' },
    });
  });
});

/**
 * F119 UX review M5 — the audit-free twin of `checkPortalAccess`'s route
 * decision, for a page that only needs to know where a link may point (the
 * sign-off page's Back link). Same two policies, no audit row: asking is not
 * a blocked action.
 */
describe('isPortalPathAllowed (the route decision without the audit)', () => {
  it.each([
    ['full', '/portal/benefits', true],
    ['full', '/portal/broadcasts/new', true],
    ['suspended', '/portal/benefits', true],
    ['suspended', '/portal/broadcasts/new', false],
    ['terminated', '/portal/benefits', false],
    ['terminated', '/portal', true],
    ['terminated', '/portal/invoices', true],
  ] as const)('%s member → %s allowed: %s', (access, pathname, allowed) => {
    expect(isPortalPathAllowed(access, pathname)).toBe(allowed);
  });

  it('agrees with checkPortalAccess for a terminated member', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    for (const pathname of ['/portal/benefits', '/portal', '/portal/renewal/x']) {
      const decision = await checkPortalAccess(deps, {
        tenantId: TENANT_ID,
        memberId: MEMBER_ID,
        pathname,
        actorUserId: 'u1',
        correlationId: 'c1',
      });
      expect(isPortalPathAllowed('terminated', pathname)).toBe(decision.allowed);
    }
  });
});
