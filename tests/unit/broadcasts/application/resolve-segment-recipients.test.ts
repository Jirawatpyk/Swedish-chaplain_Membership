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
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveSegmentRecipients } from '@/modules/broadcasts';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type {
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

interface BridgeFixture {
  readonly members?: ReadonlyArray<MemberRecipient>;
  readonly tierFilter?: (m: MemberRecipient, codes: readonly string[]) => boolean;
}

function makeMembersBridge({
  members = [],
  tierFilter = (m, codes) => codes.includes(m.tierCode ?? ''),
}: BridgeFixture = {}): MembersBridgePort {
  return {
    async getMembersBySegment(_ctx, kind, params) {
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
}: {
  readonly suppressed?: ReadonlySet<string>;
} = {}): MarketingUnsubscribesRepo {
  return {
    async upsert() {
      throw new Error('not used in resolver tests');
    },
    async findByEmailLower() {
      return null;
    },
    async lookupBatch(_tenantId, emails) {
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
}

function makeDeps(opts: DepsFixture = {}) {
  return {
    tenant,
    membersBridge: makeMembersBridge({
      ...(opts.members !== undefined && { members: opts.members }),
      ...(opts.tierFilter !== undefined && { tierFilter: opts.tierFilter }),
    }),
    eventAttendees: makeEventAttendees(
      opts.attendees !== undefined ? { attendees: opts.attendees } : {},
    ),
    marketingUnsubscribes: makeMarketingUnsubscribes(
      opts.suppressed !== undefined ? { suppressed: opts.suppressed } : {},
    ),
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: unsafeBrandEmailLower('me@example.com'),
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
      requestingMemberPrimaryEmail: unsafeBrandEmailLower('me@example.com'),
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
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
      requestingMemberPrimaryEmail: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
    }
  });
});
