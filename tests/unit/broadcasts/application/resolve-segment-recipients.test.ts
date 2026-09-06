/**
 * T044 — Unit tests for `resolve-segment-recipients.ts` Application use-case.
 *
 * Wave 6 fills the bodies. Tests exercise all 4 segment kinds + suppression
 * filter + self-exclusion (Q16) + 5k cap + halted-member exclusion + empty
 * results.
 *
 * Note: F3-side `getMembersBySegment` already filters halted members,
 * so the F7 resolver inherits that behaviour (we verify by feeding a
 * mock bridge that pre-filters or pre-excludes halted rows).
 */
import { describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { broadcastsMetrics } from '@/lib/metrics';
import { resolveSegmentRecipients, type ResolveSegmentInput } from '@/modules/broadcasts';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type {
  ContactRecipient,
  MemberRecipient,
  MembersBridgePort,
} from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { EmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts',
);

const tenant: TenantContext = asTenantContext('test-tenant');

function recipient(
  email: string,
  opts: Partial<MemberRecipient> = {},
): MemberRecipient {
  return {
    memberId: opts.memberId ?? `m-${email}`,
    displayName: opts.displayName ?? `Member ${email}`,
    primaryContactEmail:
      opts.primaryContactEmail !== undefined
        ? opts.primaryContactEmail
        : unsafeBrandEmailLower(email),
    tierCode: opts.tierCode ?? null,
    broadcastsHaltedUntilAdminReview:
      opts.broadcastsHaltedUntilAdminReview ?? false,
  };
}

/**
 * 108 PR-C — one row of the 1:N fixture. `tierCode` is test-only (the real
 * F3 row has none; the tier filter runs in SQL) so the fixture can answer a
 * `tier` segment.
 */
type ContactFixtureRow = ContactRecipient & { readonly tierCode?: string };

function contact(
  memberId: string,
  contactId: string,
  email: string,
  opts: { readonly isPrimary?: boolean; readonly tierCode?: string } = {},
): ContactFixtureRow {
  return {
    memberId,
    contactId,
    emailLower: unsafeBrandEmailLower(email),
    isPrimary: opts.isPrimary ?? false,
    ...(opts.tierCode !== undefined && { tierCode: opts.tierCode }),
  };
}

/** An eligible member with ZERO eligible contacts — F3's LEFT JOIN shape. */
function orphan(memberId: string, tierCode?: string): ContactFixtureRow {
  return {
    memberId,
    contactId: null,
    emailLower: null,
    isPrimary: false,
    ...(tierCode !== undefined && { tierCode }),
  };
}

interface BridgeFixture {
  readonly members?: ReadonlyArray<MemberRecipient>;
  readonly tierFilter?: (m: MemberRecipient, codes: readonly string[]) => boolean;
  /** 108 PR-D — addresses whose contact row carries a marketing opt-out. */
  readonly optedOut?: ReadonlySet<string>;
  /** 108 PR-D — the opt-out lookup fails (Neon outage): the bridge REJECTS. */
  readonly optOutLookupThrows?: boolean;
  /** 108 PR-D — records every batch handed to the opt-out lookup. */
  readonly optOutCalls?: Array<ReadonlyArray<EmailLower>>;
  /** 108 PR-C — rows the 1:N leg answers (already member+contact eligible). */
  readonly contacts?: ReadonlyArray<ContactFixtureRow>;
  /** 108 PR-C — a keyset page fails: the bridge THROWS (never `[]`). */
  readonly contactsPageThrows?: boolean;
  /** 108 PR-C — the primary_only read fails: the bridge THROWS (T075). */
  readonly membersReadThrows?: boolean;
  /** 108 PR-C — records which leg the resolver asked for. */
  readonly contactCalls?: Array<{ kind: string; params: unknown }>;
  readonly memberCalls?: Array<{ kind: string; params: unknown }>;
}

function makeMembersBridge({
  members = [],
  tierFilter = (m, codes) => codes.includes(m.tierCode ?? ''),
  optedOut = new Set<string>(),
  optOutLookupThrows = false,
  optOutCalls,
  contacts = [],
  contactsPageThrows = false,
  membersReadThrows = false,
  contactCalls,
  memberCalls,
}: BridgeFixture = {}): MembersBridgePort {
  return {
    // 108 PR-C — the 1:N leg (T067/T076). Mimics F3: rows are already
    // member- and contact-eligible; a `tier` segment keeps the rows whose
    // test-only tierCode matches.
    async getContactsBySegment(_ctx, kind, params) {
      contactCalls?.push({ kind, params });
      if (contactsPageThrows) {
        throw new Error('members-bridge.getContactsBySegment: repo.unexpected');
      }
      if (kind === 'all_members') return contacts;
      if (kind === 'tier') {
        const codes = params.tierCodes ?? [];
        return contacts.filter((c) => codes.includes(c.tierCode ?? ''));
      }
      return [];
    },
    async filterMarketingOptedOut(_ctx, emails) {
      optOutCalls?.push(emails);
      if (optOutLookupThrows) throw new Error('contacts lookup down');
      const matched = new Set<EmailLower>();
      for (const e of emails) {
        if (optedOut.has(e)) matched.add(e);
      }
      return matched;
    },
    async getMembersBySegment(_ctx, kind, params) {
      memberCalls?.push({ kind, params });
      if (membersReadThrows) {
        throw new Error('members-bridge.getMembersBySegment: repo.unexpected');
      }
      // Mimic F3 — already excludes halted members
      const eligible = members.filter(
        (m) => !m.broadcastsHaltedUntilAdminReview,
      );
      if (kind === 'all_members') return eligible;
      if (kind === 'tier') {
        const codes = params.tierCodes ?? [];
        return eligible.filter((m) => tierFilter(m, codes));
      }
      return [];
    },
    async getMemberPrimaryContact() {
      return null;
    },
    async lookupContactEmailInTenant() {
      return null;
    },
    async lookupMemberPrimaryContactEmailInTenant() {
      return null;
    },
    async getMembersHaltedInTenant() {
      return [];
    },
    async setMemberHalt() {
      return { ok: true, value: undefined };
    },
    async memberExistsInTenant() { return true; },
    async markBroadcastsAcknowledged() {
      return { ok: true, value: { previouslyNull: true } };
    },
    async getMemberPreferredLocale() { return null; },
  };
}

function makeEventAttendees({
  attendees = [],
}: {
  readonly attendees?: ReadonlyArray<EmailLower>;
} = {}): EventAttendeesRepository {
  return {
    async getLastNinetyDayAttendees() {
      return attendees.map((emailLower) => ({
        emailLower,
        displayName: null,
        memberId: null,
        mostRecentEventDate: new Date(),
        mostRecentEventTitle: null,
      }));
    },
    async lookupAttendeeEmailInTenant() {
      return null;
    },
  };
}

function makeMarketingUnsubscribes({
  suppressed = new Set<string>(),
  lookupCalls,
}: {
  readonly suppressed?: ReadonlySet<string>;
  /** 108 PR-C — records every batch handed to `lookupBatch` (chunking pin). */
  readonly lookupCalls?: Array<ReadonlyArray<EmailLower>>;
} = {}): MarketingUnsubscribesRepo {
  return {
    async upsert() {
      throw new Error('not used in resolver tests');
    },
    async findByEmailLower() {
      return null;
    },
    async lookupBatch(_tenantId, emails) {
      lookupCalls?.push(emails);
      const matched = new Set<EmailLower>();
      for (const e of emails) {
        if (suppressed.has(e)) matched.add(e);
      }
      return matched;
    },
    async setMemberIdNull() {
      return { affected: 0 };
    },
  };
}

interface DepsFixture {
  readonly members?: ReadonlyArray<MemberRecipient>;
  readonly attendees?: ReadonlyArray<EmailLower>;
  readonly suppressed?: ReadonlySet<string>;
  readonly tierFilter?: BridgeFixture['tierFilter'];
  readonly optedOut?: BridgeFixture['optedOut'];
  readonly optOutLookupThrows?: BridgeFixture['optOutLookupThrows'];
  readonly optOutCalls?: BridgeFixture['optOutCalls'];
  /** 108 PR-C — which resolver leg; the pre-108 cases pin `primary_only`. */
  readonly audienceMode?: 'primary_only' | 'all_contacts';
  readonly contacts?: BridgeFixture['contacts'];
  readonly contactsPageThrows?: BridgeFixture['contactsPageThrows'];
  readonly membersReadThrows?: BridgeFixture['membersReadThrows'];
  readonly contactCalls?: BridgeFixture['contactCalls'];
  readonly memberCalls?: BridgeFixture['memberCalls'];
  readonly lookupCalls?: Array<ReadonlyArray<EmailLower>>;
}

function makeDeps(opts: DepsFixture = {}) {
  return {
    tenant,
    membersBridge: makeMembersBridge({
      ...(opts.members !== undefined && { members: opts.members }),
      ...(opts.tierFilter !== undefined && { tierFilter: opts.tierFilter }),
      ...(opts.optedOut !== undefined && { optedOut: opts.optedOut }),
      ...(opts.optOutLookupThrows !== undefined && {
        optOutLookupThrows: opts.optOutLookupThrows,
      }),
      ...(opts.optOutCalls !== undefined && { optOutCalls: opts.optOutCalls }),
      ...(opts.contacts !== undefined && { contacts: opts.contacts }),
      ...(opts.contactsPageThrows !== undefined && {
        contactsPageThrows: opts.contactsPageThrows,
      }),
      ...(opts.membersReadThrows !== undefined && {
        membersReadThrows: opts.membersReadThrows,
      }),
      ...(opts.contactCalls !== undefined && { contactCalls: opts.contactCalls }),
      ...(opts.memberCalls !== undefined && { memberCalls: opts.memberCalls }),
    }),
    eventAttendees: makeEventAttendees(
      opts.attendees !== undefined ? { attendees: opts.attendees } : {},
    ),
    marketingUnsubscribes: makeMarketingUnsubscribes({
      ...(opts.suppressed !== undefined && { suppressed: opts.suppressed }),
      ...(opts.lookupCalls !== undefined && { lookupCalls: opts.lookupCalls }),
    }),
    // 108 PR-C — the flag value the composition root passes in. Every case
    // written before PR-C pins the `primary_only` leg (the flag-OFF prod
    // behaviour); the all_contacts cases opt in explicitly.
    audienceMode: opts.audienceMode ?? ('primary_only' as const),
  };
}

/** 108 PR-C — an input with every field defaulted; override what the case is about. */
function input(over: Partial<ResolveSegmentInput> = {}): ResolveSegmentInput {
  return {
    segment: { kind: 'all_members' },
    phase: 'dispatch',
    requestingMemberId: null,
    customRecipients: null,
    ...over,
  };
}

describe('resolve-segment-recipients — Wave 6 (T066 GREEN)', () => {
  it('use-case module exists at application/use-cases/resolve-segment-recipients.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ---- 4 segment-type branches --------------------------------------

  it('all_members: returns every active member with primary contact email', async () => {
    const deps = makeDeps({
      members: [recipient('a@example.com'), recipient('b@example.com')],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toContain(unsafeBrandEmailLower('a@example.com'));
      expect(result.value.recipients).toContain(unsafeBrandEmailLower('b@example.com'));
    }
  });

  it('tier:premium: returns only members on plan tier "premium"', async () => {
    const deps = makeDeps({
      members: [
        recipient('p@example.com', { tierCode: 'premium' }),
        recipient('s@example.com', { tierCode: 'standard' }),
      ],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'tier', tierCodes: ['premium'] },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toEqual([
        unsafeBrandEmailLower('p@example.com'),
      ]);
    }
  });

  it('tier with multiple codes: union of members across tiers', async () => {
    const deps = makeDeps({
      members: [
        recipient('p@example.com', { tierCode: 'premium' }),
        recipient('l@example.com', { tierCode: 'large' }),
        recipient('s@example.com', { tierCode: 'standard' }),
      ],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'tier', tierCodes: ['premium', 'large'] },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toContain(unsafeBrandEmailLower('p@example.com'));
      expect(result.value.recipients).toContain(unsafeBrandEmailLower('l@example.com'));
      expect(result.value.recipients).not.toContain(
        unsafeBrandEmailLower('s@example.com'),
      );
    }
  });

  it('event_attendees_last_90d: F7 stub returns [] (FR-015a — F6 swap-in deferred)', async () => {
    const deps = makeDeps({ attendees: [] });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'event_attendees_last_90d' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
    }
  });

  it('custom: returns recipients from pre-validated custom-list', async () => {
    const deps = makeDeps();
    const customRecipients = [
      unsafeBrandEmailLower('x@example.com'),
      unsafeBrandEmailLower('y@example.com'),
    ];
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'custom', emails: ['x@example.com', 'y@example.com'] },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toEqual(customRecipients);
    }
  });

  // ---- Suppression filter -------------------------------------------

  it('excludes recipients with active suppression record', async () => {
    const deps = makeDeps({
      members: [recipient('keep@example.com'), recipient('drop@example.com')],
      suppressed: new Set([unsafeBrandEmailLower('drop@example.com')]),
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toContain(unsafeBrandEmailLower('keep@example.com'));
      expect(result.value.recipients).not.toContain(unsafeBrandEmailLower('drop@example.com'));
    }
  });

  it('preserves recipients with NO suppression record', async () => {
    const deps = makeDeps({
      members: [recipient('a@example.com'), recipient('b@example.com')],
      suppressed: new Set(),
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toHaveLength(2);
    }
  });

  it('suppression filter applied PER tenant (cross-tenant invariant Q8)', async () => {
    // The repo's lookupBatch is bound to one tenant by construction; the
    // mock above only suppresses within the tenant under test.
    const deps = makeDeps({
      members: [recipient('a@example.com')],
      suppressed: new Set([unsafeBrandEmailLower('a@example.com')]),
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    // Recipient suppressed → empty result
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
    }
  });

  // ---- Self-exclusion (Q16 + FR-015c) -------------------------------

  it('excludes the broadcasting member themselves from recipient list', async () => {
    const deps = makeDeps({
      members: [recipient('me@example.com'), recipient('other@example.com')],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: 'm-me@example.com',
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).not.toContain(
        unsafeBrandEmailLower('me@example.com'),
      );
      expect(result.value.recipients).toContain(
        unsafeBrandEmailLower('other@example.com'),
      );
    }
  });

  it('Q16: member-self exclusion applies even on tier:<own-tier> segment', async () => {
    const deps = makeDeps({
      members: [
        recipient('me@example.com', { tierCode: 'premium' }),
        recipient('peer@example.com', { tierCode: 'premium' }),
      ],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'tier', tierCodes: ['premium'] },
      phase: 'dispatch',
      requestingMemberId: 'm-me@example.com',
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toEqual([
        unsafeBrandEmailLower('peer@example.com'),
      ]);
    }
  });

  // ---- Recipient cap (FR-016a) --------------------------------------

  it('accepts exactly 5,000 recipients (boundary)', async () => {
    const members = Array.from({ length: 5000 }, (_, i) =>
      recipient(`u${i}@example.com`),
    );
    const deps = makeDeps({ members });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toHaveLength(5000);
    }
  });

  it('rejects > 5,000 recipients with broadcast_audience_too_large', async () => {
    const members = Array.from({ length: 5001 }, (_, i) =>
      recipient(`u${i}@example.com`),
    );
    const deps = makeDeps({ members });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_audience_too_large');
      if (result.error.kind === 'broadcast_audience_too_large') {
        expect(result.error.count).toBe(5001);
        expect(result.error.cap).toBe(5000);
      }
    }
  });

  // ---- Orphan handling (FR-015c) ------------------------------------

  it('returns orphan member ids when primary_contact_email is null', async () => {
    const deps = makeDeps({
      members: [
        recipient('a@example.com'),
        recipient('orphan@example.com', {
          memberId: 'orphan-1',
          primaryContactEmail: null,
        }),
      ],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orphans).toContain('orphan-1');
      expect(result.value.recipients).toEqual([
        unsafeBrandEmailLower('a@example.com'),
      ]);
    }
  });

  it('rolls up orphan count via the orphans array for caller observability', async () => {
    const deps = makeDeps({
      members: [
        recipient('a@example.com'),
        recipient('o1', { memberId: 'o-1', primaryContactEmail: null }),
        recipient('o2', { memberId: 'o-2', primaryContactEmail: null }),
      ],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orphans).toEqual(['o-1', 'o-2']);
    }
  });

  // ---- Halted-member exclusion --------------------------------------

  it('excludes halted members from segment resolution (defence-in-depth with member-side blocking)', async () => {
    const deps = makeDeps({
      members: [
        recipient('active@example.com'),
        recipient('halted@example.com', {
          broadcastsHaltedUntilAdminReview: true,
        }),
      ],
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recipients).toEqual([
        unsafeBrandEmailLower('active@example.com'),
      ]);
    }
  });

  // ---- Empty results ------------------------------------------------

  it('returns broadcast_empty_segment_blocked when segment matches no eligible members', async () => {
    const deps = makeDeps({ members: [] });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
    }
  });

  it('custom segment with null customRecipients → empty list → broadcast_empty_segment_blocked', async () => {
    // Branch coverage: input.customRecipients ?? [] fallback (line 98)
    const deps = makeDeps();
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'custom', emails: [] },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
    }
  });
});

/**
 * 108 PR-D review cycle 10 — privacy B-1 / security HIGH-1: a per-contact
 * marketing opt-out (FR-022a) is honoured WHERE IT MATTERS — at dispatch.
 * Until this cycle the resolver consulted only the unsubscribe list, so a
 * contact switched off by staff or by themself still received every
 * broadcast (an Art. 21 objection recorded, not acted on).
 *
 * Rules pinned here:
 *   - every segment kind is filtered (members, tier, attendees, custom);
 *   - the drop is counted separately (`droppedByPreference`) and is NOT an
 *     orphan (the member still has a primary contact);
 *   - an address that is both unsubscribed and opted out counts once, as
 *     unsubscribed (suppression runs first);
 *   - the lookup failing REJECTS the resolve — never fail-open onto people
 *     who objected;
 *   - the lookup is a single batch over the post-suppression list, skipped
 *     when there is nothing left to check.
 */
describe('resolve-segment-recipients — 108 PR-D marketing opt-out at dispatch (B-1)', () => {
  const OPTED = unsafeBrandEmailLower('opted-out@example.com');

  it('all_members: an opted-out primary contact is dropped and counted as a preference drop, not an orphan', async () => {
    const deps = makeDeps({
      members: [recipient('a@example.com'), recipient('opted-out@example.com')],
      optedOut: new Set([OPTED]),
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower('a@example.com')]);
    expect(result.value.estimatedCount).toBe(1);
    expect(result.value.droppedByPreference).toBe(1);
    expect(result.value.orphans).toEqual([]);
  });

  it('tier: filtered the same way', async () => {
    const deps = makeDeps({
      members: [
        recipient('a@example.com', { tierCode: 'gold' }),
        recipient('opted-out@example.com', { tierCode: 'gold' }),
      ],
      optedOut: new Set([OPTED]),
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'tier', tierCodes: ['gold'] },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower('a@example.com')]);
    expect(result.value.droppedByPreference).toBe(1);
  });

  it('custom list: an opted-out address (e.g. a secondary contact) is dropped', async () => {
    const deps = makeDeps({ optedOut: new Set([OPTED]) });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'custom', emails: ['keep@example.com', 'opted-out@example.com'] },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: [unsafeBrandEmailLower('keep@example.com'), OPTED],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower('keep@example.com')]);
    expect(result.value.droppedByPreference).toBe(1);
  });

  it('event attendees: filtered too', async () => {
    const deps = makeDeps({
      attendees: [unsafeBrandEmailLower('keep@example.com'), OPTED],
      optedOut: new Set([OPTED]),
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'event_attendees_last_90d' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower('keep@example.com')]);
    expect(result.value.droppedByPreference).toBe(1);
  });

  it('unsubscribed AND opted out counts once, as unsubscribed (suppression runs first)', async () => {
    const calls: Array<ReadonlyArray<EmailLower>> = [];
    const deps = makeDeps({
      members: [recipient('a@example.com'), recipient('opted-out@example.com')],
      suppressed: new Set([OPTED]),
      optedOut: new Set([OPTED]),
      optOutCalls: calls,
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower('a@example.com')]);
    expect(result.value.droppedByPreference).toBe(0);
    // One batch, over the post-suppression list only.
    expect(calls).toEqual([[unsafeBrandEmailLower('a@example.com')]]);
  });

  it('nothing dropped → droppedByPreference is 0 and the metric STILL reports 0', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'marketingOptOutFilterCount');
    const deps = makeDeps({ members: [recipient('a@example.com')] });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.droppedByPreference).toBe(0);
    // Staff review P2: a filter that ran and found nothing must be
    // DISTINGUISHABLE from a filter that no longer runs. Both used to produce
    // no series at all, and SweCham cuts over with zero opt-outs — so the
    // absent-series alarm could never have fired.
    expect(spy).toHaveBeenCalledWith('test-tenant', 0, 'dispatch');
    spy.mockRestore();
  });

  it('a drop emits broadcasts.marketing_opt_out_filter_count{tenant} with the count', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'marketingOptOutFilterCount');
    const deps = makeDeps({
      members: [
        recipient('a@example.com'),
        recipient('opted-out@example.com'),
        recipient('b@example.com'),
      ],
      optedOut: new Set([OPTED, unsafeBrandEmailLower('b@example.com')]),
    });
    await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(spy).toHaveBeenCalledWith('test-tenant', 2, 'dispatch');
    spy.mockRestore();
  });

  it('everyone opted out → broadcast_empty_segment_blocked (a drop is a real removal)', async () => {
    const deps = makeDeps({
      members: [recipient('opted-out@example.com')],
      optedOut: new Set([OPTED]),
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
  });

  it('the lookup failing REJECTS the resolve — never fail-open onto people who objected', async () => {
    const deps = makeDeps({
      members: [recipient('a@example.com')],
      optOutLookupThrows: true,
    });
    await expect(
      resolveSegmentRecipients(deps, {
        segment: { kind: 'all_members' },
        phase: 'dispatch',
        requestingMemberId: null,
        customRecipients: null,
      }),
    ).rejects.toThrow('contacts lookup down');
  });

  it('nothing left after suppression → the opt-out lookup is not called', async () => {
    const calls: Array<ReadonlyArray<EmailLower>> = [];
    const deps = makeDeps({
      members: [recipient('a@example.com')],
      suppressed: new Set(['a@example.com']),
      optOutCalls: calls,
    });
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('resolve-segment-recipients — droppedByPreference is measured, not trusted (cycle 14)', () => {
  it('a bridge answering with an address outside the batch does not inflate the count', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'marketingOptOutFilterCount');
    const deps = makeDeps({
      members: [recipient('a@example.com'), recipient('b@example.com')],
      // The fixture matches `optedOut` against the batch; force a stray answer
      // by opting out an address the batch never contained.
      optedOut: new Set([unsafeBrandEmailLower('stray@example.com')]),
    });
    // Monkey-patch the fixture so the bridge returns the stray address.
    deps.membersBridge.filterMarketingOptedOut = async () =>
      new Set([unsafeBrandEmailLower('stray@example.com')]);
    const result = await resolveSegmentRecipients(deps, {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toHaveLength(2);
    expect(result.value.droppedByPreference).toBe(0);
    // A stray answer must not inflate the COUNT; the metric still reports the
    // honest 0 (staff review P2).
    expect(spy).toHaveBeenCalledWith('test-tenant', 0, 'dispatch');
    spy.mockRestore();
  });
});

/**
 * 108 PR-C T067/T076 — the `all_contacts` leg (contract broadcast-audience
 * § 1–2, FR-020–FR-023, FR-029), behind `deps.audienceMode`.
 *
 * Rules pinned here:
 *   - member-based segments fan out to EVERY eligible contact of every
 *     eligible member (the bridge already applied member + contact
 *     eligibility), in the bridge's order;
 *   - an orphan row (null contact) is the member's id in `orphans` — it is
 *     "no ELIGIBLE contact", which includes "every contact opted out";
 *   - self-exclusion is by MEMBER id and removes ALL of the sender's contacts
 *     (FR-022), on `all_members` and `tier` alike — the old email-equality
 *     arm is gone from both legs;
 *   - suppression still applies and, for member-based segments, is NOT a
 *     "preference drop"; step 4b (per-contact opt-out) still runs as defence
 *     in depth and IS counted, measured not trusted;
 *   - a failed bridge read is a typed `resolve.server_error` on BOTH legs —
 *     never an empty audience (research R8);
 *   - each leg asks exactly its own bridge method;
 *   - the ceiling and the empty check run after the fan-out.
 */
describe('resolve-segment-recipients — 108 PR-C all_contacts leg (T067/T076)', () => {
  const ALL = 'all_contacts' as const;
  const P1 = unsafeBrandEmailLower('p1@example.com');
  const S1 = unsafeBrandEmailLower('s1@example.com');
  const S2 = unsafeBrandEmailLower('s2@example.com');
  const P2 = unsafeBrandEmailLower('p2@example.com');
  const twoMembers = [
    contact('m1', 'c-p1', 'p1@example.com', { isPrimary: true }),
    contact('m1', 'c-s1', 's1@example.com'),
    contact('m1', 'c-s2', 's2@example.com'),
    contact('m2', 'c-p2', 'p2@example.com', { isPrimary: true }),
  ];

  it('all_members fans out to every eligible contact — primary AND secondary — once each, in bridge order', async () => {
    const memberCalls: Array<{ kind: string; params: unknown }> = [];
    const deps = makeDeps({ audienceMode: ALL, contacts: twoMembers, memberCalls });
    const result = await resolveSegmentRecipients(deps, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([P1, S1, S2, P2]);
    expect(result.value.estimatedCount).toBe(4);
    expect(result.value.orphans).toEqual([]);
    expect(result.value.droppedByPreference).toBe(0);
    // The 1:N leg never touches the primary-only read.
    expect(memberCalls).toEqual([]);
  });

  it('an eligible member with no eligible contact is an orphan (FR-029) — including "every contact opted out"', async () => {
    const deps = makeDeps({
      audienceMode: ALL,
      contacts: [contact('m1', 'c-p1', 'p1@example.com', { isPrimary: true }), orphan('m-empty'), orphan('m-all-off')],
    });
    const result = await resolveSegmentRecipients(deps, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([P1]);
    expect(result.value.orphans).toEqual(['m-empty', 'm-all-off']);
    // Opted-out contacts never reached the resolver (excluded in SQL), so
    // nothing is a "preference drop" here — the member is simply an orphan.
    expect(result.value.droppedByPreference).toBe(0);
  });

  it('self-exclusion is by member id and removes ALL of the sender\'s contacts (FR-022), not just the primary', async () => {
    const deps = makeDeps({ audienceMode: ALL, contacts: twoMembers });
    const result = await resolveSegmentRecipients(deps, input({ requestingMemberId: 'm1' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([P2]);
  });

  it('tier: the same contact rules apply to members of the selected tiers only, self-exclusion included', async () => {
    const deps = makeDeps({
      audienceMode: ALL,
      contacts: [
        contact('m1', 'c-p1', 'p1@example.com', { isPrimary: true, tierCode: 'gold' }),
        contact('m1', 'c-s1', 's1@example.com', { tierCode: 'gold' }),
        contact('m2', 'c-p2', 'p2@example.com', { isPrimary: true, tierCode: 'gold' }),
        contact('m3', 'c-p3', 'p3@example.com', { isPrimary: true, tierCode: 'silver' }),
      ],
    });
    const result = await resolveSegmentRecipients(
      deps,
      input({ segment: { kind: 'tier', tierCodes: ['gold'] }, requestingMemberId: 'm1' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([P2]);
  });

  it('suppression applies to secondaries too and is NOT a preference drop on a member-based segment', async () => {
    const deps = makeDeps({ audienceMode: ALL, contacts: twoMembers, suppressed: new Set([S1]) });
    const result = await resolveSegmentRecipients(deps, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([P1, S2, P2]);
    expect(result.value.droppedByPreference).toBe(0);
  });

  it('step 4b still runs as defence in depth on the 1:N leg — a stray opted-out row is dropped, counted and measured', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'marketingOptOutFilterCount');
    const deps = makeDeps({ audienceMode: ALL, contacts: twoMembers, optedOut: new Set([S2]) });
    const result = await resolveSegmentRecipients(deps, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([P1, S1, P2]);
    expect(result.value.droppedByPreference).toBe(1);
    expect(spy).toHaveBeenCalledWith('test-tenant', 1, 'dispatch');
    spy.mockRestore();
  });

  it('the same address under two contacts is sent once (FR-023)', async () => {
    const deps = makeDeps({
      audienceMode: ALL,
      contacts: [
        contact('m1', 'c-1', 'shared@example.com', { isPrimary: true }),
        contact('m2', 'c-2', 'shared@example.com', { isPrimary: true }),
      ],
    });
    const result = await resolveSegmentRecipients(deps, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower('shared@example.com')]);
  });

  it('a failed keyset page is a typed resolve.server_error — never an empty audience, never a throw', async () => {
    const deps = makeDeps({ audienceMode: ALL, contactsPageThrows: true });
    const result = await resolveSegmentRecipients(deps, input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('resolve.server_error');
  });

  it('the primary_only leg maps a failed member read the same way (T075 removed its `[]`)', async () => {
    const deps = makeDeps({ audienceMode: 'primary_only', membersReadThrows: true });
    const result = await resolveSegmentRecipients(deps, input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('resolve.server_error');
  });

  it('the primary_only leg never asks for contacts, and the all_contacts leg never asks for members', async () => {
    const contactCalls: Array<{ kind: string; params: unknown }> = [];
    const memberCalls: Array<{ kind: string; params: unknown }> = [];
    await resolveSegmentRecipients(
      makeDeps({ audienceMode: 'primary_only', members: [recipient('a@example.com')], contactCalls, memberCalls }),
      input({ segment: { kind: 'tier', tierCodes: ['x'] } }),
    );
    expect(contactCalls).toEqual([]);
    expect(memberCalls).toEqual([{ kind: 'tier', params: { tierCodes: ['x'] } }]);

    contactCalls.length = 0;
    memberCalls.length = 0;
    await resolveSegmentRecipients(
      makeDeps({ audienceMode: ALL, contacts: twoMembers, contactCalls, memberCalls }),
      input({ segment: { kind: 'tier', tierCodes: ['x'] } }),
    );
    expect(memberCalls).toEqual([]);
    expect(contactCalls).toEqual([{ kind: 'tier', params: { tierCodes: ['x'] } }]);
  });

  it('the ceiling is checked AFTER the fan-out: 5,001 contacts across members → broadcast_audience_too_large', async () => {
    const contacts = Array.from({ length: 5001 }, (_, i) =>
      contact(`m-${Math.floor(i / 3)}`, `c-${i}`, `u${i}@example.com`, { isPrimary: i % 3 === 0 }),
    );
    const result = await resolveSegmentRecipients(makeDeps({ audienceMode: ALL, contacts }), input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'broadcast_audience_too_large', count: 5001, cap: 5000 });
  });

  it('nothing left after the fan-out and the filters → broadcast_empty_segment_blocked', async () => {
    const result = await resolveSegmentRecipients(
      makeDeps({ audienceMode: ALL, contacts: [orphan('m1'), orphan('m2')] }),
      input(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
  });
});

describe('resolve-segment-recipients — 108 PR-C suppression lookup is chunked at 1,000 (contract § 2 step 5)', () => {
  it('2,500 candidates → three lookupBatch calls of 1,000 / 1,000 / 500, and a suppression in each chunk is honoured', async () => {
    const lookupCalls: Array<ReadonlyArray<EmailLower>> = [];
    const members = Array.from({ length: 2500 }, (_, i) => recipient(`u${i}@example.com`));
    const suppressed = new Set(['u0@example.com', 'u1000@example.com', 'u2499@example.com']);
    const result = await resolveSegmentRecipients(makeDeps({ members, suppressed, lookupCalls }), input());
    expect(lookupCalls.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toHaveLength(2497);
    for (const s of suppressed) {
      expect(result.value.recipients).not.toContain(unsafeBrandEmailLower(s));
    }
  });
});

/**
 * 108 PR-C T077 — FR-022a / US3 AS9: on a custom list (and the attendee
 * segment) BOTH an unsubscribed address and an opted-out contact are "excluded
 * by recipient preference" — the sender is told the count, never the
 * addresses. On a member-based segment an unsubscribed person is simply not
 * in the audience (the count shown is already the truth), so suppression is
 * not a "drop" there. The opt-out metric keeps counting opt-outs only.
 */
describe('resolve-segment-recipients — 108 PR-C custom list / attendees: droppedByPreference counts suppression AND opt-out', () => {
  it('custom: one unsubscribed + one opted-out → 2 dropped by preference; the opt-out metric reports 1', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'marketingOptOutFilterCount');
    const a = unsafeBrandEmailLower('a@example.com');
    const b = unsafeBrandEmailLower('b@example.com');
    const c = unsafeBrandEmailLower('c@example.com');
    const deps = makeDeps({ suppressed: new Set([b]), optedOut: new Set([c]) });
    const result = await resolveSegmentRecipients(
      deps,
      input({ segment: { kind: 'custom', emails: ['a@example.com', 'b@example.com', 'c@example.com'] }, phase: 'submit', customRecipients: [a, b, c] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([a]);
    expect(result.value.droppedByPreference).toBe(2);
    expect(spy).toHaveBeenCalledWith('test-tenant', 1, 'submit');
    spy.mockRestore();
  });

  it('event attendees: an unsubscribed attendee counts as dropped by preference', async () => {
    const a = unsafeBrandEmailLower('a@example.com');
    const b = unsafeBrandEmailLower('b@example.com');
    const deps = makeDeps({ attendees: [a, b], suppressed: new Set([b]) });
    const result = await resolveSegmentRecipients(deps, input({ segment: { kind: 'event_attendees_last_90d' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([a]);
    expect(result.value.droppedByPreference).toBe(1);
  });

  it('a custom list is NOT self-excluded (contract § 2 step 3, FR-022a): the sender\'s own address stays', async () => {
    const me = unsafeBrandEmailLower('me@example.com');
    const x = unsafeBrandEmailLower('x@example.com');
    const deps = makeDeps({ members: [recipient('me@example.com')] });
    const result = await resolveSegmentRecipients(
      deps,
      input({ segment: { kind: 'custom', emails: ['me@example.com', 'x@example.com'] }, requestingMemberId: 'm-me@example.com', customRecipients: [me, x] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([me, x]);
  });
});
