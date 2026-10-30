/**
 * T049 — Integration test for FR-016a / Q7 — 5,000 recipient hard cap.
 *
 * Verifies the cap at BOTH submission boundary AND resolver boundary
 * (defence-in-depth per FR-016a) by exercising `resolveSegmentRecipients`
 * with stub bridges and asserting the typed-error envelope. The
 * `estimated_recipient_count` CHECK constraint (migration 0064, raised to
 * 50000 by 0171) is verified separately by reading its definition from the
 * catalog (skipped when DATABASE_URL is missing — `requireDb()`).
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { ok } from '@/lib/result';
import { resolveSegmentRecipients } from '@/modules/broadcasts/application/use-cases/resolve-segment-recipients';
import {
  unsafeBrandEmailLower,
  type EmailLower,
} from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext } from '@/modules/tenants';
import type {
  MembersBridgePort,
  MemberRecipient,
} from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { MarketingUnsubscribesRepo } from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';

async function requireDb(): Promise<ReturnType<typeof postgres> | null> {
  if (!process.env.DATABASE_URL) return null;
  return postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });
}

const tenant = asTenantContext('test-tenant');

function makeMembers(count: number): ReadonlyArray<MemberRecipient> {
  return Array.from({ length: count }, (_, i) => ({
    memberId: `m-${i}`,
    displayName: `Member ${i}`,
    primaryContactEmail: unsafeBrandEmailLower(`m${i}@example.com`),
    tierCode: null,
    broadcastsHaltedUntilAdminReview: false,
  }));
}

function makeBridges(members: ReadonlyArray<MemberRecipient>): {
  membersBridge: MembersBridgePort;
  eventAttendees: EventAttendeesRepository;
  marketingUnsubscribes: MarketingUnsubscribesRepo;
} {
  return {
    membersBridge: {
      async getMembersBySegment() {
        return members;
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
      // Spec 139 — read first by the send-standing gate; a live member.
      async getMemberErasedAt() { return { erasedAt: null }; },
      async getMembersHaltedInTenant() {
        return [];
      },
      async setMemberHalt() {
        return ok(undefined);
      },
      async memberExistsInTenant() { return true; },
      async markBroadcastsAcknowledged() {
        return ok({ previouslyNull: true });
      },
      async filterMarketingOptedOut() { return new Set(); },
      async getContactsBySegment() { return []; },
    async countOptedOutContactsBySegment() { return 0; },
      async getMemberPreferredLocale() { return null; },
    },
    eventAttendees: {
      async getLastNinetyDayAttendees() {
        return [];
      },
      async lookupAttendeeEmailInTenant() {
        return null;
      },
    },
    marketingUnsubscribes: {
      async upsert() {
        throw new Error('not used');
      },
      async findByEmailLower() {
        return null;
      },
      async lookupBatch() {
        return new Set();
      },
      async setMemberIdNull() {
        return { affected: 0 };
      },
    },
  };
}

const SEG_ALL = { kind: 'all_members' as const };

describe('audience-cap integration (T049)', () => {
  it('5,001 members on all_members → broadcast_audience_too_large', async () => {
    const bridges = makeBridges(makeMembers(5001));
    const r = await resolveSegmentRecipients(
      { tenant, audienceMode: 'primary_only' as const, audienceCeiling: 5000, ...bridges },
      {
        segment: SEG_ALL,
        phase: 'dispatch',
        requestingMemberId: null,
        customRecipients: null,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('broadcast_audience_too_large');
      if (r.error.kind === 'broadcast_audience_too_large') {
        expect(r.error.cap).toBe(5000);
        expect(r.error.count).toBe(5001);
      }
    }
  });

  it('5,000 members exactly → succeeds (boundary)', async () => {
    const bridges = makeBridges(makeMembers(5000));
    const r = await resolveSegmentRecipients(
      { tenant, audienceMode: 'primary_only' as const, audienceCeiling: 5000, ...bridges },
      {
        segment: SEG_ALL,
        phase: 'dispatch',
        requestingMemberId: null,
        customRecipients: null,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recipients.length).toBe(5000);
  });

  it('4,999 members → succeeds', async () => {
    const bridges = makeBridges(makeMembers(4999));
    const r = await resolveSegmentRecipients(
      { tenant, audienceMode: 'primary_only' as const, audienceCeiling: 5000, ...bridges },
      {
        segment: SEG_ALL,
        phase: 'dispatch',
        requestingMemberId: null,
        customRecipients: null,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recipients.length).toBe(4999);
  });

  it('cap applies AFTER suppression filter (counts post-suppression)', async () => {
    // 5005 candidates; suppress 6 → 4999 final → succeed
    const allMembers = makeMembers(5005);
    const suppressedSet = new Set(allMembers.slice(0, 6).map((m) => m.primaryContactEmail as string));
    const r = await resolveSegmentRecipients(
      {
        tenant,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        membersBridge: makeBridges(allMembers).membersBridge,
        eventAttendees: makeBridges(allMembers).eventAttendees,
        marketingUnsubscribes: {
          async upsert() {
            throw new Error('not used');
          },
          async findByEmailLower() {
            return null;
          },
          async lookupBatch(_ctx, emails) {
            const out = new Set<EmailLower>();
            for (const e of emails) {
              if (suppressedSet.has(e as string)) out.add(e);
            }
            return out;
          },
          async setMemberIdNull() {
            return { affected: 0 };
          },
        },
      },
      {
        segment: SEG_ALL,
        phase: 'dispatch',
        requestingMemberId: null,
        customRecipients: null,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recipients.length).toBe(4999);
  });

  it('cap applies AFTER self-exclusion (Q16)', async () => {
    // 5001 candidates with self → 5000 after exclusion → succeed
    const all = makeMembers(5001);
    const r = await resolveSegmentRecipients(
      { tenant, audienceMode: 'primary_only' as const, audienceCeiling: 5000, ...makeBridges(all) },
      {
        segment: SEG_ALL,
        phase: 'dispatch',
        requestingMemberId: all[0]!.memberId,
        customRecipients: null,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.recipients.length).toBe(5000);
  });

  // ---- DB CHECK constraint defence-in-depth -------------------------
  // 135 — reads the REAL constraint from the catalog. The old test mirrored a
  // 5000 cap in a TEMP table: across separate statements on Neon's
  // transaction-mode pooler the TEMP table could land on another backend
  // (flaky "relation does not exist"), and it never checked the real
  // constraint, which migration 0171 raised to 50000.
  describe('DB CHECK constraint (broadcasts_estimated_recipient_cap)', () => {
    let dbHandle: ReturnType<typeof postgres> | null = null;
    afterAll(async () => {
      if (dbHandle !== null) await dbHandle.end({ timeout: 5 });
      dbHandle = null;
    });

    it('caps estimated_recipient_count at 0..50000', async () => {
      const dbm = await requireDb();
      if (dbm === null) return;
      dbHandle = dbm;
      const rows = await dbm<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conname = 'broadcasts_estimated_recipient_cap'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.def).toBe(
        'CHECK (((estimated_recipient_count >= 0) AND (estimated_recipient_count <= 50000)))',
      );
    });
  });
});
