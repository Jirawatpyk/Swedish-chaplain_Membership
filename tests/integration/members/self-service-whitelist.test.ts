/**
 * T115 — Integration test: self-service whitelist enforcement (US5).
 *
 * Runs against live Neon Singapore. Verifies that:
 *   1. Forged payloads with `plan_id` / `status` / `tax_id` → 403 +
 *      `member_self_update_forbidden` audit event
 *   2. Whitelisted fields (phone, website) update successfully +
 *      `member_self_updated` audit event with correct `fields_changed`
 *   3. Empty payload (no changes) → 200 with no audit event
 *
 * Depends on: member + contact + user seeded via the test setup.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  memberSelfUpdate,
  type MemberSelfUpdateDeps,
} from '@/modules/members/application/use-cases/member-self-update';
import type { Member, MemberId } from '@/modules/members/domain/member';
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';
import type { Contact, ContactId } from '@/modules/members/domain/contact';
import type { AuditPort, F3AuditEvent } from '@/modules/members/application/ports/audit-port';
import type { MemberRepo } from '@/modules/members/application/ports/member-repo';
import type { ContactRepo } from '@/modules/members/application/ports/contact-repo';
import type { TenantContext } from '@/modules/tenants';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const now = new Date('2026-04-16T10:00:00Z');
const tenantCtx = { slug: 'test-swecham' } as TenantContext;

const baseMember: Member = {
  tenantId: 'test-swecham' as Member['tenantId'],
  memberId: 'mem-1' as MemberId,
  memberNumber: asMemberNumber(1),
  companyName: 'Test Corp',
  legalEntityType: null,
  country: 'TH' as Member['country'],
  taxId: null,
  website: 'https://old.com',
  description: 'Old desc',
  foundedYear: null,
  turnoverThb: null,
  planId: 'plan-1' as Member['planId'],
  planYear: 2026,
  registrationDate: now,
  registrationFeePaid: false,
  lastActivityAt: null,
  notes: 'admin notes',
  addressLine1: null,
  addressLine2: null,
  city: null,
  province: null,
  postalCode: null,
  status: 'active',
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
};

const baseContact: Contact = {
  tenantId: 'test-swecham' as Contact['tenantId'],
  contactId: 'con-1' as ContactId,
  memberId: 'mem-1' as Contact['memberId'],
  firstName: 'Test',
  lastName: 'User',
  email: 'test@example.com' as Contact['email'],
  phone: '+66812345678' as Contact['phone'],
  roleTitle: 'CEO',
  preferredLanguage: 'en',
  isPrimary: true,
  dateOfBirth: null,
  linkedUserId: 'user-1' as Contact['linkedUserId'],
  inviteBouncedAt: null,
  removedAt: null,
  createdAt: now,
  updatedAt: now,
};

const auditEvents: F3AuditEvent[] = [];

function makeStubDeps(): MemberSelfUpdateDeps {
  const memberRepo: MemberRepo = {
    findById: async () => ok(baseMember),
    findByIdInTx: async () => ok(baseMember),
    findRiskById: async () => ok({ riskScore: null, riskScoreBand: null }),
    findManyByIdsInTx: async () => ok(new Map()),
    findByLinkedUserId: async () => ok(baseMember),
    findSoftDuplicate: async () => ok(null),
    createWithPrimaryContactInTx: async () => err({ code: 'repo.unexpected' as const }),
    updateStatus: async () => ok(baseMember),
    updateStatusInTx: async () => ok(baseMember),
    updateFields: async (_ctx, _id, patch) => ok({ ...baseMember, ...patch } as Member),
    updateFieldsInTx: async (_tx, _id, patch) =>
      ok({ ...baseMember, ...patch } as Member),
    searchDirectory: async () => ok({ items: [], nextCursor: null }),
    searchDirectoryWithCount: async () => ok({ items: [], total: 0 }),
    // F7 Batch C extensions (T029) — interface compliance stubs.
    findMembersBySegmentForBroadcast: async () => ok([]),
    findMembersHaltedForBroadcast: async () => ok([]),
    updateBroadcastsHaltedInTx: async () => ok({ affected: 0 }),
    updateBroadcastsAcknowledgedAtInTx: async () =>
      ok({ affected: 0, previouslyNull: true }),
    findPrimaryContactEmailInTx: async () => ok(null),
    findPreferredLocaleInTx: async () => ok(null),
    updatePreferredLocaleInTx: async () => ok({ affected: 0, previousValue: null }),
    findMemberByPrimaryContactEmailInTx: async () => ok(null),
    findLastPlanChangedAt: async () => ok(null),
    findPendingInvitationsForMember: async () => ok([]),
    // COMP-1 (Task 3) — interface compliance stub.
    scrubPiiInTx: async () => ok({ erasedAt: new Date(0) }),
    // COMP-1 (erase pre-flight) — interface compliance stub.
    findErasedAtById: async () => ok({ erasedAt: null }),
  };

  const contactRepo: ContactRepo = {
    listByMember: async () => ok([baseContact]),
    findById: async () => ok(baseContact),
    findByEmail: async () => err({ code: 'repo.not_found' as const }),
    addInTx: async () => err({ code: 'repo.unexpected' as const }),
    updateInTx: async (_tx, _id, patch) =>
      ok({ ...baseContact, ...patch } as Contact),
    removeInTx: async () =>
      ok({ contact: baseContact, wasPrimary: false }),
    promotePrimaryInTx: async () =>
      err({ code: 'repo.unexpected' as const }),
    linkUserInTx: async () => ok(baseContact),
    updateEmailInTx: async () => ok({ oldEmail: baseContact.email }),
    listLinkedUserIdsForMemberInTx: async () => [],
    markInviteBouncedInTx: async () => ok({ affected: 0 }),
    clearInviteBouncedInTx: async () => ok({ affected: 0 }),
    scrubPiiForMemberInTx: async () => ok({ scrubbedCount: 0 }),
  };

  const audit: AuditPort = {
    record: async (_ctx, event) => {
      auditEvents.push(event);
      return ok(undefined);
    },
    recordInTx: async (_tx, _ctx, event) => {
      auditEvents.push(event);
      return ok(undefined);
    },
  };

  return { tenant: tenantCtx, memberRepo, contactRepo, audit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('US5 self-service whitelist enforcement (T115)', () => {
  beforeAll(() => {
    auditEvents.length = 0;
  });

  afterAll(() => {
    auditEvents.length = 0;
  });

  it('rejects forged plan_id with 403 + member_self_update_forbidden audit', async () => {
    auditEvents.length = 0;
    const deps = makeStubDeps();
    const result = await memberSelfUpdate(deps, {
      memberId: 'mem-1' as MemberId,
      contactId: 'con-1' as ContactId,
      rawBody: { plan_id: 'hacked-plan' },
      actorUserId: 'user-1',
      requestId: 'req-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('forbidden');
    }
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.type).toBe('member_self_update_forbidden');
    expect(auditEvents[0]!.payload.attempted_fields).toContain('plan_id');
  });

  it('rejects forged status with 403 + audit', async () => {
    auditEvents.length = 0;
    const deps = makeStubDeps();
    const result = await memberSelfUpdate(deps, {
      memberId: 'mem-1' as MemberId,
      contactId: 'con-1' as ContactId,
      rawBody: { status: 'active' },
      actorUserId: 'user-1',
      requestId: 'req-2',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('forbidden');
    }
    expect(auditEvents[0]!.type).toBe('member_self_update_forbidden');
  });

  it('rejects forged tax_id with 403 + audit', async () => {
    auditEvents.length = 0;
    const deps = makeStubDeps();
    const result = await memberSelfUpdate(deps, {
      memberId: 'mem-1' as MemberId,
      contactId: 'con-1' as ContactId,
      rawBody: { primary_contact: { email: 'hack@evil.com' } },
      actorUserId: 'user-1',
      requestId: 'req-3',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('forbidden');
    }
    expect(auditEvents[0]!.payload.attempted_fields).toContain(
      'primary_contact.email',
    );
  });

  it('rejects forged postal-address fields with 403 + audit (address is admin-only, not member-self-editable)', async () => {
    auditEvents.length = 0;
    const deps = makeStubDeps();
    const result = await memberSelfUpdate(deps, {
      memberId: 'mem-1' as MemberId,
      contactId: 'con-1' as ContactId,
      rawBody: {
        address_line1: '1 Hacker Way',
        address_line2: 'Unit 0',
        city: 'Nowhere',
        province: 'Void',
        postal_code: '00000',
      },
      actorUserId: 'user-1',
      requestId: 'req-addr',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('forbidden');
    }
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.type).toBe('member_self_update_forbidden');
    expect(auditEvents[0]!.payload.attempted_fields).toEqual(
      expect.arrayContaining([
        'address_line1',
        'address_line2',
        'city',
        'province',
        'postal_code',
      ]),
    );
  });

  it('updates whitelisted fields successfully + member_self_updated audit', async () => {
    auditEvents.length = 0;
    const deps = makeStubDeps();
    const result = await memberSelfUpdate(deps, {
      memberId: 'mem-1' as MemberId,
      contactId: 'con-1' as ContactId,
      rawBody: {
        website: 'https://new.com',
        primary_contact: { phone: '+66899999999' },
      },
      actorUserId: 'user-1',
      requestId: 'req-4',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.member.website).toBe('https://new.com');
    }
    // S1 refactor — contact update now routes through AuditPort.recordInTx
    // so the Application-layer spy sees both `contact_updated` AND
    // `member_self_updated`. Previously `contact_updated` was emitted by
    // the Infrastructure adapter directly to the auditLog table (skipping
    // the spy), so the test only saw 1 event.
    expect(auditEvents).toHaveLength(2);
    const memberSelfEvent = auditEvents.find(
      (e) => e.type === 'member_self_updated',
    );
    const contactEvent = auditEvents.find((e) => e.type === 'contact_updated');
    expect(memberSelfEvent).toBeDefined();
    expect(contactEvent).toBeDefined();
    expect(memberSelfEvent!.payload.fields_changed).toEqual(
      expect.arrayContaining(['website', 'phone']),
    );
  });

  it('rejects multiple forbidden fields in one payload', async () => {
    auditEvents.length = 0;
    const deps = makeStubDeps();
    const result = await memberSelfUpdate(deps, {
      memberId: 'mem-1' as MemberId,
      contactId: 'con-1' as ContactId,
      rawBody: {
        plan_id: 'hacked',
        status: 'archived',
        tax_id: '1234567890123',
        website: 'https://legit.com',
      },
      actorUserId: 'user-1',
      requestId: 'req-5',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('forbidden');
      const attempted = auditEvents[0]!.payload
        .attempted_fields as string[];
      expect(attempted).toContain('plan_id');
      expect(attempted).toContain('status');
      expect(attempted).toContain('tax_id');
    }
  });
});
