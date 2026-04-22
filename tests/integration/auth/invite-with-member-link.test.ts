/**
 * Integration test — F1 spec § "Linkage to member records" (spec.md:672-678).
 *
 * When an admin invites a `member`-role user with an optional `memberId`,
 * the invitation flow must atomically:
 *
 *   1. Create the F1 pending user + invitation + outbox row + `account_created` audit
 *      (the existing `createUser` behaviour)
 *   2. Create a secondary Contact row on the given member, with
 *      `contacts.linked_user_id = users.id` (the new F3-augmented step)
 *   3. Emit a `contact_created` audit row in the same transaction
 *
 * Tenant isolation: the memberId MUST belong to the caller's tenant.
 * Cross-tenant memberId → `member_not_found` + `member_cross_tenant_probe`
 * audit row (FR-022 pattern re-used from `get-member`).
 *
 * Covers 5 scenarios:
 *   (a) happy path — memberId belongs to tenant, everything lands
 *   (b) invalid memberId format — non-UUID rejected at zod boundary
 *   (c) cross-tenant memberId — returns `member_not_found`, probe emitted
 *   (d) role=admin + memberId — rejected 400 (not silently ignored — chosen
 *       for clarity; rationale documented in the route handler)
 *   (e) memberId absent — existing F1 flow still works (no contact created)
 *
 * Uses the use-case directly (not through HTTP) because the spec gap is
 * at the use-case layer — we exercise the new `inviteUserForMember` use case
 * end-to-end against live Neon Singapore, with real repos + adapters. The
 * route-level wiring (zod schema branch, HTTP status mapping) is covered
 * by unit tests on the route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  auditLog,
  invitations,
  notificationsOutbox,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { inviteUserForMember } from '@/modules/members/application/use-cases/invite-user-for-member';
import { createUser as f1CreateUser } from '@/modules/auth/application/create-user';
import type { CreateUserPort } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

const PLAN_ID = 'test-premium';

// Adapt F1 createUser to the narrowed CreateUserPort the use case expects.
const createUserPort: CreateUserPort = async (input) => {
  const result = await f1CreateUser({
    email: input.email,
    role: input.role,
    displayName: input.displayName ?? null,
    actorUserId: input.actorUserId as never,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    locale: input.locale,
  });
  if (result.ok) {
    return { ok: true, value: { user: { id: result.value.user.id } } };
  }
  return { ok: false, error: { code: result.error.code } };
};

async function seedTenantPlanAndSettings(ctx: TestTenant['ctx'], adminId: string) {
  await runInTenant(ctx, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: ctx.slug,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: 100000n,
      legalNameTh: 'Test TH',
      legalNameEn: 'Test EN',
      taxId: '0000000000000',
      registeredAddressTh: 'Test Address TH',
      registeredAddressEn: 'Test Address EN',
      invoiceNumberPrefix: 'INV',
      creditNoteNumberPrefix: 'CN',
    });
    await tx.insert(membershipPlans).values({
      tenantId: ctx.slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Test Premium' },
      description: { en: '' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: MATRIX,
      isActive: true,
      createdBy: adminId,
      updatedBy: adminId,
    });
  });
}

describe('integration: admin invite with optional memberId (F1 spec:672-678)', () => {
  let admin: TestUser;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let memberIdA: MemberId;
  let memberIdB: MemberId;
  const createdUserEmails: string[] = [];

  beforeEach(async () => {
    admin = await createActiveTestUser('admin');
    const twoTenants = await createTwoTestTenants();
    tenantA = twoTenants.a;
    tenantB = twoTenants.b;

    await seedTenantPlanAndSettings(tenantA.ctx, admin.userId);
    await seedTenantPlanAndSettings(tenantB.ctx, admin.userId);

    const depsA = buildMembersDeps(tenantA.ctx);
    const memberA = await createMember(
      {
        company_name: `Alpha Co ${Date.now()}`,
        country: 'TH',
        plan_id: PLAN_ID,
        plan_year: 2026,
        primary_contact: {
          first_name: 'Primary',
          last_name: 'Alpha',
          email: `primary-a-${randomUUID().slice(0, 8)}@example.com`,
          preferred_language: 'en',
        },
      },
      { actorUserId: admin.userId, requestId: `rq-seed-a-${Date.now()}` },
      depsA,
    );
    if (!memberA.ok) throw new Error(`seed memberA failed: ${JSON.stringify(memberA.error)}`);
    memberIdA = memberA.value.memberId;

    const depsB = buildMembersDeps(tenantB.ctx);
    const memberB = await createMember(
      {
        company_name: `Beta Co ${Date.now()}`,
        country: 'TH',
        plan_id: PLAN_ID,
        plan_year: 2026,
        primary_contact: {
          first_name: 'Primary',
          last_name: 'Beta',
          email: `primary-b-${randomUUID().slice(0, 8)}@example.com`,
          preferred_language: 'en',
        },
      },
      { actorUserId: admin.userId, requestId: `rq-seed-b-${Date.now()}` },
      depsB,
    );
    if (!memberB.ok) throw new Error(`seed memberB failed: ${JSON.stringify(memberB.error)}`);
    memberIdB = memberB.value.memberId;
  }, 60_000);

  afterEach(async () => {
    // Clean invitees + outbox created in each test.
    for (const email of createdUserEmails) {
      await db
        .delete(notificationsOutbox)
        .where(eq(notificationsOutbox.toEmail, email.toLowerCase()));
      await db.delete(users).where(eq(users.email, email.toLowerCase()));
    }
    createdUserEmails.length = 0;
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin);
  });

  it('(a) happy path: memberId in tenant → user + invitation + contact + link + audits', async () => {
    const depsA = buildMembersDeps(tenantA.ctx);
    const inviteeEmail = `invitee-${randomUUID().slice(0, 8)}@example.com`;
    createdUserEmails.push(inviteeEmail);
    const requestId = `rq-invite-${Date.now()}`;

    const result = await inviteUserForMember(
      {
        tenant: tenantA.ctx,
        contactRepo: depsA.contactRepo,
        audit: depsA.audit,
        memberRepo: depsA.memberRepo,
        createUser: createUserPort,
        idFactory: depsA.idFactory,
      },
      {
        memberId: memberIdA,
        email: inviteeEmail,
        displayName: 'Invited User',
        actorUserId: admin.userId,
        sourceIp: '203.0.113.30',
        requestId,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const userId = result.value.userId;

    // 1. F1 user exists with pending status
    const userRows = await db.select().from(users).where(eq(users.id, userId));
    expect(userRows.length).toBe(1);
    expect(userRows[0]!.status).toBe('pending');
    expect(userRows[0]!.role).toBe('member');

    // 2. Invitation row exists
    const invRows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.userId, userId));
    expect(invRows.length).toBe(1);

    // 3. Outbox row enqueued (cross-tenant: tenant_id is null)
    const outboxRows = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.toEmail, inviteeEmail.toLowerCase()),
          eq(notificationsOutbox.notificationType, 'member_invitation'),
          isNull(notificationsOutbox.tenantId),
        ),
      );
    expect(outboxRows.length).toBe(1);

    // 4. Contact row created on the target member and linked to the user
    const contactRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.memberId, memberIdA),
            eq(contacts.linkedUserId, userId),
          ),
        ),
    );
    expect(contactRows.length).toBe(1);
    expect(contactRows[0]!.isPrimary).toBe(false);
    expect(contactRows[0]!.email).toBe(inviteeEmail.toLowerCase());

    // 5. Audit has both account_created (F1) and contact_created (F3)
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorUserId, admin.userId));
    const eventTypes = auditRows.map((r) => r.eventType);
    expect(eventTypes).toContain('account_created');
    expect(eventTypes).toContain('contact_created');
  });

  it('(c) cross-tenant memberId → member_not_found + probe audit emitted', async () => {
    // Use tenant A deps but pass memberId from tenant B — RLS hides the row.
    const depsA = buildMembersDeps(tenantA.ctx);
    const inviteeEmail = `crosstenant-${randomUUID().slice(0, 8)}@example.com`;
    // Not pushing to createdUserEmails — expected rollback, no user should land.

    const result = await inviteUserForMember(
      {
        tenant: tenantA.ctx,
        contactRepo: depsA.contactRepo,
        audit: depsA.audit,
        memberRepo: depsA.memberRepo,
        createUser: createUserPort,
        idFactory: depsA.idFactory,
      },
      {
        memberId: memberIdB,
        email: inviteeEmail,
        actorUserId: admin.userId,
        sourceIp: '203.0.113.31',
        requestId: `rq-xtenant-${Date.now()}`,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('member_not_found');

    // Probe audit on tenant A (the actor's tenant)
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, admin.userId),
          eq(auditLog.tenantId, tenantA.ctx.slug),
          eq(auditLog.eventType, 'member_cross_tenant_probe'),
        ),
      );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    // No F1 user should have been created (we abort BEFORE createUser)
    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.email, inviteeEmail.toLowerCase()));
    expect(userRows.length).toBe(0);
  });

  it('(e) memberId absent: existing F1 flow still works (standalone user, no contact)', async () => {
    // Directly call F1 createUser — the baseline flow — to confirm it
    // remains unchanged. The route handler branches on memberId presence;
    // when absent it goes through this exact path.
    const inviteeEmail = `solo-${randomUUID().slice(0, 8)}@example.com`;
    createdUserEmails.push(inviteeEmail);

    const result = await f1CreateUser({
      email: inviteeEmail,
      role: 'member',
      actorUserId: admin.userId,
      sourceIp: '203.0.113.32',
      requestId: `rq-solo-${Date.now()}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const userId = result.value.user.id;

    // No contact linked to this user anywhere
    const contactRows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.linkedUserId, userId));
    expect(contactRows.length).toBe(0);
  });

  // (b) invalid memberId format and (d) role=admin+memberId are route-handler
  // concerns (zod schema + branch rejection). Route-level coverage lives in
  // a separate contract test. The use-case contract here only guarantees
  // behaviour when the caller has already parsed memberId as a branded
  // MemberId — invalid formats never reach this layer.

  // -------------------------------------------------------------------------
  // Hybrid A+B scenarios — duplicate-email handling (findByEmail pre-tx check)
  // -------------------------------------------------------------------------

  it('(f) same-member unlinked contact → link to existing contact + contact_linked_to_user audit (NOT contact_created)', async () => {
    // Seed: manually insert a contact row on memberA with email john@example.com
    // and linkedUserId = NULL. The use case should detect this existing contact,
    // skip addInTx, create an F1 user, and call linkUserInTx on the existing row.
    const inviteeEmail = `john-unlinked-${randomUUID().slice(0, 8)}@example.com`;
    createdUserEmails.push(inviteeEmail);

    const existingContactId = randomUUID();

    // Insert the pre-existing unlinked contact directly via raw Drizzle
    // (bypassing the use case to simulate a contact that already exists
    // from a previous import / manual admin creation).
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: existingContactId,
        memberId: memberIdA,
        firstName: 'Existing',
        lastName: 'Person',
        email: inviteeEmail.toLowerCase(),
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: null,
        removedAt: null,
      });
    });

    const depsA = buildMembersDeps(tenantA.ctx);
    // Use a fixed requestId so we can scope the audit query to ONLY events
    // emitted by this specific invite call — beforeEach also creates contacts
    // under the same actorUserId which would otherwise pollute the audit log.
    const inviteRequestId = `rq-hybrid-a-${randomUUID().slice(0, 8)}`;
    const result = await inviteUserForMember(
      {
        tenant: tenantA.ctx,
        contactRepo: depsA.contactRepo,
        audit: depsA.audit,
        memberRepo: depsA.memberRepo,
        createUser: createUserPort,
        idFactory: depsA.idFactory,
      },
      {
        memberId: memberIdA,
        email: inviteeEmail,
        displayName: 'Admin Typed Name',
        actorUserId: admin.userId,
        sourceIp: '203.0.113.40',
        requestId: inviteRequestId,
      },
    );

    // 1. Use case succeeds.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const userId = result.value.userId;

    // 2. F1 user was created with the admin-supplied displayName.
    const userRows = await db.select().from(users).where(eq(users.id, userId));
    expect(userRows.length).toBe(1);
    expect(userRows[0]!.email).toBe(inviteeEmail.toLowerCase());
    expect(userRows[0]!.displayName).toBe('Admin Typed Name');

    // 3. The ORIGINAL contact row was reused — firstName + lastName must NOT
    //    be overwritten with the admin-typed display name.
    const contactRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.memberId, memberIdA),
            eq(contacts.email, inviteeEmail.toLowerCase()),
          ),
        ),
    );
    // Exactly one contact row (no new row was inserted).
    expect(contactRows.length).toBe(1);
    expect(contactRows[0]!.contactId).toBe(existingContactId);
    expect(contactRows[0]!.firstName).toBe('Existing');
    expect(contactRows[0]!.lastName).toBe('Person');
    // And it is now linked to the new F1 user.
    expect(contactRows[0]!.linkedUserId).toBe(userId);

    // 4. Audit scoped to this request: contact_linked_to_user present, contact_created absent.
    // Scope by requestId to avoid noise from beforeEach member/contact creation.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.requestId, inviteRequestId),
          eq(auditLog.tenantId, tenantA.ctx.slug),
        ),
      );
    const eventTypes = auditRows.map((r) => r.eventType);
    expect(eventTypes).toContain('contact_linked_to_user');
    expect(eventTypes).not.toContain('contact_created');
  });

  it('(g) same-member already-linked contact → 409 contact_already_linked; no new user created', async () => {
    // Seed: contact with email jane@example.com on memberA, linkedUserId already set.
    const inviteeEmail = `jane-linked-${randomUUID().slice(0, 8)}@example.com`;
    // Do NOT push to createdUserEmails — the invite must be rejected before
    // any F1 user is created.

    // First create the existing "already linked" user so we have a valid UUID.
    const existingResult = await f1CreateUser({
      email: `linked-owner-${randomUUID().slice(0, 8)}@example.com`,
      role: 'member',
      actorUserId: admin.userId,
      sourceIp: '203.0.113.41',
      requestId: `rq-seed-linked-${Date.now()}`,
    });
    if (!existingResult.ok) throw new Error('seed existing user failed');
    const existingUserId = existingResult.value.user.id;
    // Track for cleanup.
    createdUserEmails.push(existingResult.value.user.email);

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId: memberIdA,
        firstName: 'Jane',
        lastName: 'Linked',
        email: inviteeEmail.toLowerCase(),
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: existingUserId,   // <-- already linked
        removedAt: null,
      });
    });

    const depsA = buildMembersDeps(tenantA.ctx);
    const result = await inviteUserForMember(
      {
        tenant: tenantA.ctx,
        contactRepo: depsA.contactRepo,
        audit: depsA.audit,
        memberRepo: depsA.memberRepo,
        createUser: createUserPort,
        idFactory: depsA.idFactory,
      },
      {
        memberId: memberIdA,
        email: inviteeEmail,
        displayName: 'Should Not Matter',
        actorUserId: admin.userId,
        sourceIp: '203.0.113.41',
        requestId: `rq-hybrid-b-linked-${Date.now()}`,
      },
    );

    // 1. Use case must reject with contact_already_linked.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('contact_already_linked');

    // 2. No NEW F1 user row was created for inviteeEmail.
    const newUserRows = await db
      .select()
      .from(users)
      .where(eq(users.email, inviteeEmail.toLowerCase()));
    expect(newUserRows.length).toBe(0);

    // 3. No new contact row for inviteeEmail (count for memberA must still be 1
    //    for that email — the pre-seeded row only).
    const contactRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.memberId, memberIdA),
            eq(contacts.email, inviteeEmail.toLowerCase()),
          ),
        ),
    );
    expect(contactRows.length).toBe(1);
    // Original contact still linked to the original user — not overwritten.
    expect(contactRows[0]!.linkedUserId).toBe(existingUserId);
  });

  it('(h) contact on different member (same tenant) → 409 email_belongs_to_other_member; no side-effects on target member', async () => {
    // Spec: 1 email = 1 member within a tenant. The email bob@example.com is
    // already registered as a contact on memberA (tenantA). When the admin
    // tries to invite that same email targeting a SECOND member in the same
    // tenant (memberDelta), the use case must reject before any F1 side-effects.
    const inviteeEmail = `bob-crossmember-${randomUUID().slice(0, 8)}@example.com`;
    // Do NOT push to createdUserEmails — no user should be created.

    // Step 1: Create a second member in tenantA (the "target" member the admin
    // mistakenly tries to link bob@ to).
    const depsA = buildMembersDeps(tenantA.ctx);
    const secondMember = await createMember(
      {
        company_name: `Delta Co ${Date.now()}`,
        country: 'TH',
        plan_id: PLAN_ID,
        plan_year: 2026,
        primary_contact: {
          first_name: 'Primary',
          last_name: 'Delta',
          email: `primary-delta-${randomUUID().slice(0, 8)}@example.com`,
          preferred_language: 'en',
        },
      },
      { actorUserId: admin.userId, requestId: `rq-seed-delta-${Date.now()}` },
      depsA,
    );
    if (!secondMember.ok)
      throw new Error(`seed secondMember failed: ${JSON.stringify(secondMember.error)}`);
    const memberIdDelta = secondMember.value.memberId;

    // Step 2: Seed a contact with inviteeEmail on memberA (the "owner" member).
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId: memberIdA,
        firstName: 'Bob',
        lastName: 'CrossMember',
        email: inviteeEmail.toLowerCase(),
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: null,
        removedAt: null,
      });
    });

    // Step 3: Attempt to invite inviteeEmail, targeting memberIdDelta — the
    // email belongs to memberA, so this must be rejected.
    const result = await inviteUserForMember(
      {
        tenant: tenantA.ctx,
        contactRepo: depsA.contactRepo,
        audit: depsA.audit,
        memberRepo: depsA.memberRepo,
        createUser: createUserPort,
        idFactory: depsA.idFactory,
      },
      {
        memberId: memberIdDelta,
        email: inviteeEmail,
        displayName: 'Bob Attempt',
        actorUserId: admin.userId,
        sourceIp: '203.0.113.42',
        requestId: `rq-hybrid-crossmember-${Date.now()}`,
      },
    );

    // 1. Rejected with email_belongs_to_other_member.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('email_belongs_to_other_member');

    // 2. No F1 user was created for inviteeEmail.
    const newUserRows = await db
      .select()
      .from(users)
      .where(eq(users.email, inviteeEmail.toLowerCase()));
    expect(newUserRows.length).toBe(0);

    // 3. No contact row was created on memberIdDelta.
    const deltaContactRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.memberId, memberIdDelta),
            eq(contacts.email, inviteeEmail.toLowerCase()),
          ),
        ),
    );
    expect(deltaContactRows.length).toBe(0);

    // 4. Original contact on memberIdA is untouched (still unlinked).
    const originalContactRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.memberId, memberIdA),
            eq(contacts.email, inviteeEmail.toLowerCase()),
          ),
        ),
    );
    expect(originalContactRows.length).toBe(1);
    expect(originalContactRows[0]!.linkedUserId).toBeNull();
  });
});
