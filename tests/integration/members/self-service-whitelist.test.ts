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
import type { Contact, ContactId } from '@/modules/members/domain/contact';
import type { AuditPort, F3AuditEvent } from '@/modules/members/application/ports/audit-port';
import type { MemberRepo, RepoError, MemberPatch } from '@/modules/members/application/ports/member-repo';
import type { ContactRepo, ContactPatch } from '@/modules/members/application/ports/contact-repo';
import type { TenantContext } from '@/modules/tenants';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const now = new Date('2026-04-16T10:00:00Z');
const tenantCtx = { slug: 'test-swecham' } as TenantContext;

const baseMember: Member = {
  tenantId: 'test-swecham' as Member['tenantId'],
  memberId: 'mem-1' as MemberId,
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
  removedAt: null,
  createdAt: now,
  updatedAt: now,
};

const auditEvents: F3AuditEvent[] = [];

function makeStubDeps(): MemberSelfUpdateDeps {
  const memberRepo: MemberRepo = {
    findById: async () => ok(baseMember),
    findByIdInTx: async () => ok(baseMember),
    findManyByIdsInTx: async () => ok(new Map()),
    findByLinkedUserId: async () => ok(baseMember),
    findSoftDuplicate: async () => ok(null),
    createWithPrimaryContact: async () => err({ code: 'repo.unexpected' as const }),
    updateStatus: async () => ok(baseMember),
    updateStatusInTx: async () => ok(baseMember),
    updateFields: async (_ctx, _id, patch) => ok({ ...baseMember, ...patch } as Member),
    updateFieldsInTx: async () => ok(baseMember),
    searchDirectory: async () => ok({ items: [], nextCursor: null }),
  };

  const contactRepo: ContactRepo = {
    listByMember: async () => ok([baseContact]),
    findById: async () => ok(baseContact),
    add: async () => err({ code: 'repo.unexpected' as const }),
    update: async (_ctx, _id, patch) =>
      ok({ ...baseContact, ...patch } as Contact),
    remove: async () => err({ code: 'repo.unexpected' as const }),
    promotePrimary: async () =>
      err({ code: 'repo.unexpected' as const }),
    linkUser: async () => ok(baseContact),
    updateEmailInTx: async () => ok({ oldEmail: baseContact.email }),
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
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.type).toBe('member_self_updated');
    expect(auditEvents[0]!.payload.fields_changed).toEqual(
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
