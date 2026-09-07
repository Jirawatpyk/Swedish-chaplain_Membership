/**
 * 108 PR-C T069/T075 — `membersBridge` adapter (F7 → F3), unit.
 *
 * The adapter is the one place where an F3 repo failure could quietly become
 * an EMPTY audience. Pinned:
 *   - `getContactsBySegment` walks the F3 keyset pages to exhaustion — page
 *     size 5,000, cursor = the last row of the previous page INCLUDING an
 *     orphan row's null contact id — and stops on the first short page;
 *   - orphan rows (null contact) are forwarded, not dropped; emails come back
 *     branded and lower-cased; tier codes are forwarded verbatim;
 *   - the non-member segment kinds answer `[]` WITHOUT an F3 call (they are
 *     resolved elsewhere — unchanged from `getMembersBySegment`);
 *   - a failed page PROPAGATES by throwing — never `[]` (research R8: an
 *     adapter answering `[]` on error is a second silent-truncation vector) —
 *     and the error log carries the error class only, never an address
 *     (FR-053a);
 *   - `getMembersBySegment` (the `primary_only` leg) loses its `return []` on
 *     error for the same reason (T075, members-bridge.ts:88).
 *
 * The F3 barrel is mocked at the module boundary; nothing here touches a DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';

const f3 = vi.hoisted(() => ({
  getBroadcastRecipientContacts: vi.fn(),
  getMembersBySegment: vi.fn(),
  countBroadcastOptedOutContacts: vi.fn(),
}));

vi.mock('@/modules/members', () => ({
  drizzleMemberRepo: { kind: 'member-repo-stub' },
  drizzleContactRepo: { kind: 'contact-repo-stub' },
  asMemberId: (id: string) => id,
  getBroadcastRecipientContacts: (...a: unknown[]) => f3.getBroadcastRecipientContacts(...a),
  getMembersBySegment: (...a: unknown[]) => f3.getMembersBySegment(...a),
  countBroadcastOptedOutContacts: (...a: unknown[]) => f3.countBroadcastOptedOutContacts(...a),
  getMemberPrimaryContact: vi.fn(),
  getMemberPreferredLocale: vi.fn(),
  lookupContactEmailInTenant: vi.fn(),
  filterMarketingOptedOutEmails: vi.fn(),
  lookupMemberPrimaryContactEmailInTenant: vi.fn(),
  getMembersHaltedInTenant: vi.fn(),
  setMemberHalt: vi.fn(),
  markBroadcastsAcknowledged: vi.fn(),
}));

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: log }));

import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import * as f3mod from '@/modules/members';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';

const tenant = asTenantContext('test-tenant');

type F3Row = {
  memberId: string;
  contactId: string | null;
  emailLower: string | null;
  hasOptedOutContact: boolean;
};

function contactRow(memberId: string, contactId: string, hasOptedOutContact = false): F3Row {
  return { memberId, contactId, emailLower: `${contactId}@example.com`, hasOptedOutContact };
}
function orphanRow(memberId: string): F3Row {
  return { memberId, contactId: null, emailLower: null, hasOptedOutContact: false };
}
function fullPage(prefix: string, n = 5000): F3Row[] {
  return Array.from({ length: n }, (_, i) =>
    contactRow(`${prefix}-m-${Math.floor(i / 2)}`, `${prefix}-c-${i}`, i % 2 === 0),
  );
}

function callInput(n: number): { after: unknown; limit: unknown; segmentType: unknown; tierCodes?: unknown } {
  const input = f3.getBroadcastRecipientContacts.mock.calls[n]?.[1] as Record<string, unknown>;
  return input as never;
}

beforeEach(() => {
  f3.getBroadcastRecipientContacts.mockReset();
  f3.getMembersBySegment.mockReset();
  log.error.mockReset();
});

describe('membersBridge.getContactsBySegment (108 PR-C T075)', () => {
  it('walks the keyset pages to exhaustion: a full page is followed by the next page, whose cursor is the last row', async () => {
    const page1 = fullPage('p1');
    const page2 = [contactRow('z-m-1', 'z-c-1'), contactRow('z-m-1', 'z-c-2'), orphanRow('z-m-2')];
    f3.getBroadcastRecipientContacts
      .mockResolvedValueOnce(ok(page1))
      .mockResolvedValueOnce(ok(page2));

    const rows = await membersBridge.getContactsBySegment(tenant, 'all_members', {});

    expect(rows).toHaveLength(5003);
    expect(f3.getBroadcastRecipientContacts).toHaveBeenCalledTimes(2);
    expect(callInput(0)).toEqual({ segmentType: 'all_members', after: null, limit: 5000 });
    const last = page1[page1.length - 1]!;
    expect(callInput(1)).toEqual({
      segmentType: 'all_members',
      after: { kind: 'after_contact', memberId: last.memberId, contactId: last.contactId },
      limit: 5000,
    });
  });

  it('a short page ends the loop — a 5-row audience is ONE F3 call', async () => {
    f3.getBroadcastRecipientContacts.mockResolvedValueOnce(ok(fullPage('s', 5)));
    const rows = await membersBridge.getContactsBySegment(tenant, 'all_members', {});
    expect(rows).toHaveLength(5);
    expect(f3.getBroadcastRecipientContacts).toHaveBeenCalledTimes(1);
  });

  it('an exact multiple of the page size needs one more (empty) page to prove exhaustion', async () => {
    f3.getBroadcastRecipientContacts
      .mockResolvedValueOnce(ok(fullPage('e')))
      .mockResolvedValueOnce(ok([]));
    const rows = await membersBridge.getContactsBySegment(tenant, 'all_members', {});
    expect(rows).toHaveLength(5000);
    expect(f3.getBroadcastRecipientContacts).toHaveBeenCalledTimes(2);
  });

  it('a page ending on an ORPHAN row resumes with a null contact id in the cursor, and the orphan is forwarded', async () => {
    const page1 = [...fullPage('o', 4999), orphanRow('o-orphan')];
    f3.getBroadcastRecipientContacts
      .mockResolvedValueOnce(ok(page1))
      .mockResolvedValueOnce(ok([contactRow('o-tail', 'o-tail-c')]));

    const rows = await membersBridge.getContactsBySegment(tenant, 'all_members', {});

    expect(callInput(1).after).toEqual({ kind: 'after_member', memberId: 'o-orphan' });
    const orphan = rows.find((r) => r.memberId === 'o-orphan');
    expect(orphan).toEqual({ memberId: 'o-orphan', contactId: null, emailLower: null, hasOptedOutContact: false });
    expect(rows).toHaveLength(5001);
  });

  it('brands and lower-cases emails, keeps hasOptedOutContact, forwards tier codes verbatim', async () => {
    f3.getBroadcastRecipientContacts.mockResolvedValueOnce(
      ok([{ memberId: 'm-1', contactId: 'c-1', emailLower: 'Mixed.Case@Example.COM', hasOptedOutContact: true }]),
    );
    const rows = await membersBridge.getContactsBySegment(tenant, 'tier', { tierCodes: ['corporate'] });
    expect(rows).toEqual([
      { memberId: 'm-1', contactId: 'c-1', emailLower: 'mixed.case@example.com', hasOptedOutContact: true },
    ]);
    expect(callInput(0)).toEqual({
      segmentType: 'tier',
      tierCodes: ['corporate'],
      after: null,
      limit: 5000,
    });
  });

  it('event attendees and custom lists answer [] without an F3 call (resolved elsewhere, unchanged)', async () => {
    expect(await membersBridge.getContactsBySegment(tenant, 'event_attendees_last_90d', {})).toEqual([]);
    expect(await membersBridge.getContactsBySegment(tenant, 'custom', {})).toEqual([]);
    expect(f3.getBroadcastRecipientContacts).not.toHaveBeenCalled();
  });

  it('a failed page PROPAGATES — throws, never [] — and the log names the error class, never an address', async () => {
    f3.getBroadcastRecipientContacts
      .mockResolvedValueOnce(ok(fullPage('f')))
      .mockResolvedValueOnce(err({ code: 'repo.unexpected' as const, cause: new Error('neon down') }));

    await expect(
      membersBridge.getContactsBySegment(tenant, 'all_members', {}),
    ).rejects.toThrow(/repo\.unexpected/);

    expect(log.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.error.mock.calls[0]);
    expect(logged).toContain('repo.unexpected');
    expect(logged).not.toMatch(/@example\.com/);
  });
});

describe('membersBridge — the other lookups discriminate "no data" from "no answer" (review 2026-09-07)', () => {
  // Same doctrine as `memberExistsInTenant` (T075 / R5-S2): `repo.not_found`
  // and a null value are a genuine miss → null / []; `repo.unexpected` is a
  // failed READ and THROWS, so the caller surfaces a 500/retry instead of a
  // fabricated "no primary contact" / "nobody is halted" / "unattributed".
  const boom = () => err({ code: 'repo.unexpected' as const, cause: new Error('neon down') });

  it('getMemberPrimaryContact: repo.unexpected THROWS; not_found / null answer null', async () => {
    vi.mocked(f3mod.getMemberPrimaryContact).mockResolvedValueOnce(boom() as never);
    await expect(membersBridge.getMemberPrimaryContact(tenant, 'm-1')).rejects.toThrow(/repo\.unexpected/);
    vi.mocked(f3mod.getMemberPrimaryContact).mockResolvedValueOnce(ok(null) as never);
    expect(await membersBridge.getMemberPrimaryContact(tenant, 'm-1')).toBeNull();
    vi.mocked(f3mod.getMemberPrimaryContact).mockResolvedValueOnce(err({ code: 'repo.not_found' as const }) as never);
    expect(await membersBridge.getMemberPrimaryContact(tenant, 'm-1')).toBeNull();
  });

  it('getMembersHaltedInTenant: repo.unexpected THROWS — a halt gate must never fail open', async () => {
    vi.mocked(f3mod.getMembersHaltedInTenant).mockResolvedValueOnce(boom() as never);
    await expect(membersBridge.getMembersHaltedInTenant(tenant)).rejects.toThrow(/repo\.unexpected/);
  });

  it('lookupContactEmailInTenant: repo.unexpected THROWS; not_found / null answer null', async () => {
    const email = unsafeBrandEmailLower('a@b.co');
    vi.mocked(f3mod.lookupContactEmailInTenant).mockResolvedValueOnce(boom() as never);
    await expect(membersBridge.lookupContactEmailInTenant(tenant, email)).rejects.toThrow(/repo\.unexpected/);
    vi.mocked(f3mod.lookupContactEmailInTenant).mockResolvedValueOnce(ok(null) as never);
    expect(await membersBridge.lookupContactEmailInTenant(tenant, email)).toBeNull();
    vi.mocked(f3mod.lookupContactEmailInTenant).mockResolvedValueOnce(err({ code: 'repo.not_found' as const }) as never);
    expect(await membersBridge.lookupContactEmailInTenant(tenant, email)).toBeNull();
  });

  it('lookupMemberPrimaryContactEmailInTenant: repo.unexpected THROWS; not_found / null answer null', async () => {
    const email = unsafeBrandEmailLower('a@b.co');
    vi.mocked(f3mod.lookupMemberPrimaryContactEmailInTenant).mockResolvedValueOnce(boom() as never);
    await expect(membersBridge.lookupMemberPrimaryContactEmailInTenant(tenant, email)).rejects.toThrow(
      /repo\.unexpected/,
    );
    vi.mocked(f3mod.lookupMemberPrimaryContactEmailInTenant).mockResolvedValueOnce(ok(null) as never);
    expect(await membersBridge.lookupMemberPrimaryContactEmailInTenant(tenant, email)).toBeNull();
  });
});

describe('membersBridge.getMembersBySegment — the primary_only leg propagates too (T075 :88)', () => {
  it('an F3 error THROWS instead of answering an empty audience', async () => {
    f3.getMembersBySegment.mockResolvedValueOnce(
      err({ code: 'repo.unexpected' as const, cause: new Error('neon down') }),
    );
    await expect(membersBridge.getMembersBySegment(tenant, 'all_members', {})).rejects.toThrow(
      /repo\.unexpected/,
    );
  });

  it('a successful read is branded as before', async () => {
    f3.getMembersBySegment.mockResolvedValueOnce(
      ok([
        {
          memberId: 'm-1',
          displayName: 'One',
          primaryContactEmail: 'One@Example.com',
          tierCode: 'corporate',
          broadcastsHaltedUntilAdminReview: false,
        },
      ]),
    );
    const rows = await membersBridge.getMembersBySegment(tenant, 'all_members', {});
    expect(rows).toEqual([
      {
        memberId: 'm-1',
        displayName: 'One',
        primaryContactEmail: 'one@example.com',
        tierCode: 'corporate',
        broadcastsHaltedUntilAdminReview: false,
      },
    ]);
  });
});

/**
 * 108 PR-C T090 — `broadcasts_audience_pages_total{tenant}`: the number of
 * F3 keyset pages a 1:N resolve walked. Emitted once per completed walk
 * (never on a failed page), so a rising pages-per-resolve is the early signal
 * of a tenant approaching the per-tick budget.
 */
describe('membersBridge.getContactsBySegment — pages metric (108 PR-C T090)', () => {
  it('records the page count after a completed walk (2 pages here)', async () => {
    const { broadcastsMetrics } = await import('@/lib/metrics');
    const spy = vi.spyOn(broadcastsMetrics, 'audiencePagesTotal');
    f3.getBroadcastRecipientContacts
      .mockResolvedValueOnce(ok(fullPage('pg')))
      .mockResolvedValueOnce(ok([contactRow('t-m', 't-c')]));
    await membersBridge.getContactsBySegment(tenant, 'all_members', {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('test-tenant', 2);
    spy.mockRestore();
  });
});

describe('membersBridge.countOptedOutContactsBySegment — the SQL-excluded opt-outs, counted (review 2026-09-07)', () => {
  it("answers F3's address-level count and forwards the segment + tier codes", async () => {
    f3.countBroadcastOptedOutContacts.mockResolvedValueOnce(ok(3));
    const n = await membersBridge.countOptedOutContactsBySegment(tenant, 'tier', { tierCodes: ['corporate'] });
    expect(n).toBe(3);
    const input = f3.countBroadcastOptedOutContacts.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).toEqual({ segmentType: 'tier', tierCodes: ['corporate'] });
  });

  it('a failed count THROWS — the preference number is fail-closed like the opt-out filter', async () => {
    f3.countBroadcastOptedOutContacts.mockResolvedValueOnce(
      err({ code: 'repo.unexpected' as const, cause: new Error('neon down') }),
    );
    await expect(membersBridge.countOptedOutContactsBySegment(tenant, 'all_members', {})).rejects.toThrow(
      /repo\.unexpected/,
    );
  });

  it('custom / attendee segments are not member-keyed: answers 0 without a read', async () => {
    expect(await membersBridge.countOptedOutContactsBySegment(tenant, 'custom', {})).toBe(0);
    expect(await membersBridge.countOptedOutContactsBySegment(tenant, 'event_attendees_last_90d', {})).toBe(0);
    expect(f3.countBroadcastOptedOutContacts).not.toHaveBeenCalled();
  });
});
