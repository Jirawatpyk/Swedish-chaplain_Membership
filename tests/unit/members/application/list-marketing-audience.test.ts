/**
 * 108 PR-D T044 (US4 / FR-035, FR-035b) — `listMarketingAudience`: the read
 * behind the Marketing audience page.
 *
 * What is pinned here is the FILTER → REPO-PREDICATE mapping and the per-row
 * state derivation, both of which decide what the pre-flight preset
 * (`kind=secondary&state=on&eligible=1`) shows staff before the first send
 * under the new rule (FR-027a):
 *   - `state=on` must exclude SUPPRESSED addresses at the query, not just
 *     re-label them — otherwise the preset lists people who will not receive;
 *   - `state=unsubscribed` is answered from the suppression list;
 *   - a suppression outage degrades to "status unavailable" on every row and
 *     drops the suppression legs (rows shown, FR-035b), except for
 *     `state=unsubscribed`, which has nothing truthful to show;
 *   - pages are 50 rows, page numbers clamp to ≥ 1.
 *
 * Live-Neon coverage of the SQL itself:
 * tests/integration/members/marketing-audience-query.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  listMarketingAudience,
  MARKETING_AUDIENCE_PAGE_SIZE,
  asMemberId,
} from '@/modules/members';
import type { ListMarketingAudienceDeps } from '@/modules/members/application/use-cases/list-marketing-audience';
import type {
  MarketingAudienceRepoFilter,
  MarketingAudienceRepoRow,
} from '@/modules/members/application/ports/member-repo';
import { asTenantContext } from '@/modules/tenants';
import {
  RECEIVES_MARKETING,
  type Contact,
  type ContactId,
  type MarketingOptOut,
} from '@/modules/members/domain/contact';

const tenant = asTenantContext('test-tenant');
const M1 = asMemberId('11111111-1111-4111-8111-111111111111');
const NOW = new Date('2026-09-06T10:00:00Z');
const STAFF = 'a6c5b1a2-0000-4000-8000-00000000aaaa';

function contact(id: string, email: string, marketing: MarketingOptOut = RECEIVES_MARKETING, isPrimary = false): Contact {
  return {
    tenantId: 'test-tenant',
    contactId: id as ContactId,
    memberId: M1,
    firstName: 'F',
    lastName: `L-${id.slice(0, 4)}`,
    email,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    dateOfBirth: null,
    linkedUserId: null,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    marketing,
    isPrimary,
    removedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as Contact;
}

function row(c: Contact, member: Partial<MarketingAudienceRepoRow['member']> = {}): MarketingAudienceRepoRow {
  return {
    contact: c,
    member: {
      memberId: M1,
      memberNumber: 42,
      companyName: 'Acme Co',
      status: 'active',
      erased: false,
      halted: false,
      ...member,
    },
  };
}

const ON = contact('c1000000-0000-4000-8000-000000000001', 'On@Example.com', RECEIVES_MARKETING, true);
const OFF_STAFF = contact('c1000000-0000-4000-8000-000000000002', 'staffoff@example.com', {
  optedOutAt: NOW,
  source: 'staff',
  byUserId: STAFF as never,
});
const OFF_SELF = contact('c1000000-0000-4000-8000-000000000003', 'selfoff@example.com', {
  optedOutAt: NOW,
  source: 'self',
  byUserId: 'a6c5b1a2-0000-4000-8000-00000000bbbb' as never,
});
const UNSUB = contact('c1000000-0000-4000-8000-000000000004', 'unsub@example.com');

function makeDeps(opts: {
  rows?: MarketingAudienceRepoRow[];
  total?: number;
  suppressedAll?: ReadonlySet<string> | 'throws';
  lookup?: 'throws';
  repoFails?: boolean;
} = {}) {
  const rows = opts.rows ?? [row(ON), row(OFF_STAFF), row(OFF_SELF), row(UNSUB)];
  const memberRepo = {
    listContactsForMarketingAudience: vi.fn(async (_ctx: unknown, _f: MarketingAudienceRepoFilter) =>
      opts.repoFails
        ? err({ code: 'repo.unexpected' as const, cause: new Error('boom') })
        : ok({ rows, total: opts.total ?? rows.length }),
    ),
  };
  const suppressedAll = opts.suppressedAll ?? new Set(['unsub@example.com']);
  const marketingSuppression = {
    isSuppressed: vi.fn(),
    listSuppressedEmailLowers: vi.fn(async () => {
      if (suppressedAll === 'throws') throw new Error('suppression db down');
      return suppressedAll;
    }),
    lookupSuppressed: vi.fn(async (emails: readonly string[]) => {
      if (opts.lookup === 'throws') throw new Error('suppression db down');
      const all = suppressedAll === 'throws' ? new Set<string>() : suppressedAll;
      return new Set(emails.map((e) => e.toLowerCase()).filter((e) => all.has(e)));
    }),
  };
  const deps: ListMarketingAudienceDeps = { tenant, memberRepo, marketingSuppression };
  return { deps, memberRepo, marketingSuppression };
}

const repoFilter = (memberRepo: ReturnType<typeof makeDeps>['memberRepo']) =>
  memberRepo.listContactsForMarketingAudience.mock.calls[0]![1] as MarketingAudienceRepoFilter;

describe('listMarketingAudience — filter → repo predicate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('default view: eligible only, page 1 of 50, no state legs, no suppression list fetch', async () => {
    const { deps, memberRepo, marketingSuppression } = makeDeps();
    const r = await listMarketingAudience({ filter: { eligible: true }, page: 1 }, deps);
    expect(r.ok).toBe(true);
    expect(repoFilter(memberRepo)).toEqual({
      eligibleOnly: true,
      limit: MARKETING_AUDIENCE_PAGE_SIZE,
      offset: 0,
    });
    expect(MARKETING_AUDIENCE_PAGE_SIZE).toBe(50);
    expect(marketingSuppression.listSuppressedEmailLowers).not.toHaveBeenCalled();
    // Per-row suppression is resolved for the page only.
    expect(marketingSuppression.lookupSuppressed).toHaveBeenCalledTimes(1);
  });

  it('passes q / memberId / kind through; eligible=false lifts the member-eligibility leg', async () => {
    const { deps, memberRepo } = makeDeps();
    await listMarketingAudience(
      { filter: { q: 'acme', memberId: M1, kind: 'secondary', eligible: false }, page: 1 },
      deps,
    );
    expect(repoFilter(memberRepo)).toMatchObject({
      q: 'acme',
      memberId: M1,
      kind: 'secondary',
      eligibleOnly: false,
    });
  });

  it('state=on → optOut none AND the suppressed addresses excluded at the query (FR-027a preset)', async () => {
    const { deps, memberRepo, marketingSuppression } = makeDeps({
      suppressedAll: new Set(['unsub@example.com', 'other@example.com']),
    });
    await listMarketingAudience({ filter: { state: 'on', eligible: true }, page: 1 }, deps);
    expect(marketingSuppression.listSuppressedEmailLowers).toHaveBeenCalledTimes(1);
    const f = repoFilter(memberRepo);
    expect(f.optOut).toBe('none');
    expect([...(f.emailLowerNotIn ?? [])].sort()).toEqual(['other@example.com', 'unsub@example.com']);
    expect(f.emailLowerIn).toBeUndefined();
  });

  it('state=on with an empty suppression list → no NOT IN leg at all', async () => {
    const { deps, memberRepo } = makeDeps({ suppressedAll: new Set() });
    await listMarketingAudience({ filter: { state: 'on', eligible: true }, page: 1 }, deps);
    expect(repoFilter(memberRepo).emailLowerNotIn).toBeUndefined();
  });

  // Both `off_*` filters EXCLUDE suppressed addresses (cycle 13, review LOW-7):
  // the badge on such a row reads "unsubscribed" — precedence — so a filter
  // named "off (by staff)" must not list it. That makes the whole-tenant
  // suppression fetch necessary for these two as well.
  it('state=off_by_staff → optOut staff, suppressed addresses excluded', async () => {
    const { deps, memberRepo, marketingSuppression } = makeDeps();
    await listMarketingAudience({ filter: { state: 'off_by_staff', eligible: true }, page: 1 }, deps);
    expect(marketingSuppression.listSuppressedEmailLowers).toHaveBeenCalledTimes(1);
    const f = repoFilter(memberRepo);
    expect(f.optOut).toBe('staff');
    expect(f.emailLowerNotIn).toEqual(['unsub@example.com']);
    expect(f.emailLowerIn).toBeUndefined();
  });

  it('state=off_by_contact → optOut self, suppressed addresses excluded', async () => {
    const { deps, memberRepo, marketingSuppression } = makeDeps();
    await listMarketingAudience(
      { filter: { state: 'off_by_contact', eligible: true }, page: 1 },
      deps,
    );
    expect(marketingSuppression.listSuppressedEmailLowers).toHaveBeenCalledTimes(1);
    const f = repoFilter(memberRepo);
    expect(f.optOut).toBe('self');
    expect(f.emailLowerNotIn).toEqual(['unsub@example.com']);
  });

  it('no state filter → the whole-tenant suppression list is NOT fetched', async () => {
    const { deps, marketingSuppression } = makeDeps();
    await listMarketingAudience({ filter: { eligible: true }, page: 1 }, deps);
    expect(marketingSuppression.listSuppressedEmailLowers).not.toHaveBeenCalled();
  });

  it('state=unsubscribed → IN the suppression list, any opt-out state', async () => {
    const { deps, memberRepo } = makeDeps();
    await listMarketingAudience({ filter: { state: 'unsubscribed', eligible: true }, page: 1 }, deps);
    const f = repoFilter(memberRepo);
    expect(f.emailLowerIn).toEqual(['unsub@example.com']);
    expect(f.optOut).toBeUndefined();
  });

  it('state=unsubscribed with an EMPTY suppression list → empty page without touching the repo', async () => {
    const { deps, memberRepo } = makeDeps({ suppressedAll: new Set() });
    const r = await listMarketingAudience({ filter: { state: 'unsubscribed', eligible: true }, page: 1 }, deps);
    expect(r.ok && r.value).toMatchObject({ rows: [], total: 0, degraded: false });
    expect(memberRepo.listContactsForMarketingAudience).not.toHaveBeenCalled();
  });

  it('page 3 → offset 100; page 0 / negative / NaN clamp to page 1', async () => {
    const a = makeDeps();
    await listMarketingAudience({ filter: { eligible: true }, page: 3 }, a.deps);
    expect(repoFilter(a.memberRepo)).toMatchObject({ limit: 50, offset: 100 });
    for (const page of [0, -4, Number.NaN]) {
      const b = makeDeps();
      const r = await listMarketingAudience({ filter: { eligible: true }, page }, b.deps);
      expect(repoFilter(b.memberRepo).offset).toBe(0);
      expect(r.ok && r.value.page).toBe(1);
    }
  });
});

describe('listMarketingAudience — row projection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('derives the displayed state per row (suppression > opt-out > on) and the FR-031b reasons', async () => {
    const { deps } = makeDeps();
    const r = await listMarketingAudience({ filter: { eligible: false }, page: 1 }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degraded).toBe(false);
    expect(r.value.total).toBe(4);
    expect(r.value.rows.map((x) => [x.contactId, x.state, x.reasons])).toEqual([
      [ON.contactId, 'on', []],
      [OFF_STAFF.contactId, 'off_by_staff', ['off_by_staff']],
      [OFF_SELF.contactId, 'off_by_contact', ['off_by_contact']],
      [UNSUB.contactId, 'unsubscribed', ['unsubscribed']],
    ]);
  });

  it('carries the member facts + who/when changed it; email is lower-cased for the lookup only', async () => {
    const { deps, marketingSuppression } = makeDeps({
      rows: [row(ON, { status: 'inactive', halted: true }), row(OFF_STAFF)],
    });
    const r = await listMarketingAudience({ filter: { eligible: false }, page: 1 }, deps);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.rows[0]).toMatchObject({
      memberId: M1,
      memberNumber: 42,
      companyName: 'Acme Co',
      firstName: 'F',
      isPrimary: true,
      memberStatus: 'inactive',
      memberHalted: true,
      memberErased: false,
      email: 'On@Example.com',
      changedByUserId: null,
      changedSource: null,
      changedAt: null,
      reasons: ['member_inactive', 'member_halted'],
    });
    expect(r.value.rows[1]).toMatchObject({
      changedByUserId: STAFF,
      changedSource: 'staff',
      changedAt: NOW,
    });
    expect(marketingSuppression.lookupSuppressed).toHaveBeenCalledWith([
      'on@example.com',
      'staffoff@example.com',
    ]);
  });

  it('reuses the whole-tenant suppression set for the page rows when it was already fetched (state=on)', async () => {
    const { deps, marketingSuppression } = makeDeps();
    await listMarketingAudience({ filter: { state: 'on', eligible: true }, page: 1 }, deps);
    expect(marketingSuppression.listSuppressedEmailLowers).toHaveBeenCalledTimes(1);
    expect(marketingSuppression.lookupSuppressed).not.toHaveBeenCalled();
  });

  it('an empty page skips the per-row lookup', async () => {
    const { deps, marketingSuppression } = makeDeps({ rows: [], total: 0 });
    const r = await listMarketingAudience({ filter: { eligible: true }, page: 1 }, deps);
    expect(r.ok && r.value.rows).toEqual([]);
    expect(marketingSuppression.lookupSuppressed).not.toHaveBeenCalled();
  });
});

describe('listMarketingAudience — degraded suppression (FR-031a / FR-035b)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('per-row lookup outage → every row "unavailable", degraded=true, rows still shown', async () => {
    const { deps } = makeDeps({ lookup: 'throws' });
    const r = await listMarketingAudience({ filter: { eligible: true }, page: 1 }, deps);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.degraded).toBe(true);
    expect(r.value.rows).toHaveLength(4);
    expect(new Set(r.value.rows.map((x) => x.state))).toEqual(new Set(['unavailable']));
    // No state reason can be asserted when nothing is known.
    expect(r.value.rows.every((x) => x.reasons.length === 0)).toBe(true);
  });

  it('state=on with the list unreadable → empty + degraded (it cannot be answered)', async () => {
    // Superseded by review errors MEDIUM-2 (cycle 15): listing with the
    // suppression leg silently dropped put people who unsubscribed under
    // "on" and inflated the pre-flight count.
    const { deps, memberRepo } = makeDeps({ suppressedAll: 'throws' });
    const r = await listMarketingAudience({ filter: { state: 'on', eligible: true }, page: 1 }, deps);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value).toMatchObject({ rows: [], total: 0, degraded: true });
    expect(memberRepo.listContactsForMarketingAudience).not.toHaveBeenCalled();
  });

  it('state=unsubscribed with the list unreadable → nothing truthful to show: empty + degraded', async () => {
    const { deps, memberRepo } = makeDeps({ suppressedAll: 'throws' });
    const r = await listMarketingAudience(
      { filter: { state: 'unsubscribed', eligible: true }, page: 1 },
      deps,
    );
    expect(r.ok && r.value).toMatchObject({ rows: [], total: 0, degraded: true });
    expect(memberRepo.listContactsForMarketingAudience).not.toHaveBeenCalled();
  });

  it('repo failure → server_error', async () => {
    const { deps } = makeDeps({ repoFails: true });
    const r = await listMarketingAudience({ filter: { eligible: true }, page: 1 }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('server_error');
  });
});

describe('listMarketingAudience — a degraded suppression read never over-reports (cycle 15)', () => {
  // Review errors MEDIUM-2: `state=unsubscribed` already returns empty when
  // the list is unreadable. `on` and both `off_*` are defined BY that same
  // list (they exclude it), so answering them without it lists and counts
  // people who unsubscribed — on the very page (FR-027a pre-flight) whose job
  // is to say who will receive.
  it.each(['on', 'off_by_staff', 'off_by_contact'] as const)(
    'state=%s + unreadable list → empty + degraded, and the repo is never asked',
    async (state) => {
      const { deps, memberRepo } = makeDeps({ suppressedAll: 'throws' });
      const r = await listMarketingAudience({ filter: { state, eligible: true }, page: 1 }, deps);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toMatchObject({ rows: [], total: 0, degraded: true });
      expect(memberRepo.listContactsForMarketingAudience).not.toHaveBeenCalled();
    },
  );

  it('no state filter + a per-page lookup failure still lists the page, degraded', async () => {
    // The unfiltered view does not depend on the list to decide membership —
    // only to label rows — so it stays useful.
    const { deps, memberRepo } = makeDeps({ lookup: 'throws' });
    const r = await listMarketingAudience({ filter: { eligible: true }, page: 1 }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.degraded).toBe(true);
    expect(r.value.rows.length).toBeGreaterThan(0);
    expect(memberRepo.listContactsForMarketingAudience).toHaveBeenCalled();
  });
});
