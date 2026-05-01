/**
 * T050 — F6 EventAttendees stub-port (FR-015a).
 *
 * Verifies the stub returns `[]` and the upstream resolve-segment use
 * case surfaces `broadcast_empty_segment_blocked` for the
 * `event_attendees_last_90d` segment until F6 ships. Forward-compat
 * with the EventAttendeesRepository port is verified by a structural
 * type-shape assertion.
 */
import { describe, expect, it } from 'vitest';
import { ok } from '@/lib/result';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { resolveSegmentRecipients } from '@/modules/broadcasts/application/use-cases/resolve-segment-recipients';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext } from '@/modules/tenants';
import type {
  EventAttendeesRepository,
} from '@/modules/broadcasts/application/ports/event-attendees-repository';
import type {
  MembersBridgePort,
} from '@/modules/broadcasts/application/ports/members-bridge-port';
import type {
  MarketingUnsubscribesRepo,
} from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';

const tenant = asTenantContext('test-tenant');

const emptyMembersBridge: MembersBridgePort = {
  async getMembersBySegment() {
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
    return ok(undefined);
  },
  async memberExistsInTenant() { return true; },
  async markBroadcastsAcknowledged() {
    return ok({ previouslyNull: true });
  },
};

const emptyUnsubscribes: MarketingUnsubscribesRepo = {
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
};

describe('event-attendees-stub (T050)', () => {
  it('stub.getLastNinetyDayAttendees returns empty array', async () => {
    const result = await eventAttendeesStub.getLastNinetyDayAttendees(tenant);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('stub.lookupAttendeeEmailInTenant returns null for any input', async () => {
    const r = await eventAttendeesStub.lookupAttendeeEmailInTenant(
      tenant,
      unsafeBrandEmailLower('any@example.com'),
    );
    expect(r).toBeNull();
  });

  it('resolve-segment with event_attendees_last_90d → empty → broadcast_empty_segment_blocked', async () => {
    const r = await resolveSegmentRecipients(
      {
        tenant,
        membersBridge: emptyMembersBridge,
        eventAttendees: eventAttendeesStub,
        marketingUnsubscribes: emptyUnsubscribes,
      },
      {
        segment: { kind: 'event_attendees_last_90d' },
        requestingMemberPrimaryEmail: null,
        customRecipients: null,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('broadcast_empty_segment_blocked');
  });

  it('stub satisfies EventAttendeesRepository port (forward-compat F6 swap-in)', () => {
    const _shape: EventAttendeesRepository = eventAttendeesStub;
    // Methods present
    expect(typeof eventAttendeesStub.getLastNinetyDayAttendees).toBe(
      'function',
    );
    expect(typeof eventAttendeesStub.lookupAttendeeEmailInTenant).toBe(
      'function',
    );
  });

  it('multiple invocations remain deterministic (no state)', async () => {
    const a = await eventAttendeesStub.getLastNinetyDayAttendees(tenant);
    const b = await eventAttendeesStub.getLastNinetyDayAttendees(tenant);
    expect(a).toEqual(b);
  });

  it('lookup returns null for varied input emails', async () => {
    expect(
      await eventAttendeesStub.lookupAttendeeEmailInTenant(
        tenant,
        unsafeBrandEmailLower('a@example.com'),
      ),
    ).toBeNull();
    expect(
      await eventAttendeesStub.lookupAttendeeEmailInTenant(
        tenant,
        unsafeBrandEmailLower('b@example.com'),
      ),
    ).toBeNull();
  });
});
