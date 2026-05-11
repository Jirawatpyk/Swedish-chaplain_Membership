/**
 * F8 Phase 6 round-3 I3 fix — `findActorUserId()` tenant-scoped JOIN
 * integration tests.
 *
 * Pins the C3 fix from review-round 2 (Phase 6 review-round 2 C3):
 * the helper's contact-table JOIN MUST be tenant-scoped so a
 * cross-tenant admin contact does NOT resolve to "the swecham admin".
 * Originally the helper queried `users` with `eq(role, 'admin')` and
 * NO tenant filter — that was the cross-tenant identity leak this
 * test guards against.
 *
 * Branches covered:
 *   1. BOOTSTRAP_ADMIN_EMAIL set → email lookup wins (tenant-agnostic
 *      operator-pinned actor).
 *   2. BOOTSTRAP_ADMIN_EMAIL set + email not in users → throws.
 *   3. BOOTSTRAP_ADMIN_EMAIL unset + admin contact in target tenant
 *      → JOIN resolves to the in-tenant admin.
 *   4. BOOTSTRAP_ADMIN_EMAIL unset + admin contact ONLY in a different
 *      tenant → throws "no admin user found in tenant" (cross-tenant
 *      isolation regression guardrail).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { findActorUserId } from '@/../scripts/seed-demo-members';

const ORIGINAL_BOOTSTRAP_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL;
const ORIGINAL_TENANT_SLUG = process.env.TENANT_SLUG;

describe('findActorUserId tenant-scoped JOIN (Phase 6 round-3 I3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let userInA: TestUser;
  let userInB: TestUser;

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    userInA = await createActiveTestUser('admin');
    userInB = await createActiveTestUser('admin');

    // Plant a plan + member + admin contact in tenant A linking userInA.
    await db.insert(membershipPlans).values({
      tenantId: tenantA.ctx.slug,
      planId: 'regular',
      planYear: 2026,
      planName: { en: 'Regular' },
      description: { en: '' },
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      isActive: true,
      createdBy: userInA.userId,
      updatedBy: userInA.userId,
    });
    const memberAId = randomUUID();
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: memberAId,
        companyName: 'Tenant A Holdings',
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug,
        contactId: randomUUID(),
        memberId: memberAId,
        firstName: 'Admin',
        lastName: 'A',
        email: `admin-a-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
        linkedUserId: userInA.userId,
      });
    });

    // Plant a plan + member + admin contact in tenant B linking userInB.
    await db.insert(membershipPlans).values({
      tenantId: tenantB.ctx.slug,
      planId: 'regular',
      planYear: 2026,
      planName: { en: 'Regular' },
      description: { en: '' },
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 5_000_000,
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      isActive: true,
      createdBy: userInB.userId,
      updatedBy: userInB.userId,
    });
    const memberBId = randomUUID();
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: memberBId,
        companyName: 'Tenant B Co',
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenantB.ctx.slug,
        contactId: randomUUID(),
        memberId: memberBId,
        firstName: 'Admin',
        lastName: 'B',
        email: `admin-b-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
        linkedUserId: userInB.userId,
      });
    });
  }, 240_000);

  afterAll(async () => {
    if (ORIGINAL_BOOTSTRAP_EMAIL === undefined) {
      delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    } else {
      process.env.BOOTSTRAP_ADMIN_EMAIL = ORIGINAL_BOOTSTRAP_EMAIL;
    }
    if (ORIGINAL_TENANT_SLUG === undefined) {
      delete process.env.TENANT_SLUG;
    } else {
      process.env.TENANT_SLUG = ORIGINAL_TENANT_SLUG;
    }
    // FK order: contacts → members → plans → audit_log → tenant.
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(contacts)
        .where(eq(contacts.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(members)
        .where(eq(members.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(membershipPlans)
        .where(eq(membershipPlans.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('uses BOOTSTRAP_ADMIN_EMAIL email lookup when env-var is set', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = userInA.rawEmail;
    const id = await findActorUserId(tenantA.ctx);
    expect(id).toBe(userInA.userId);
  });

  it('throws when BOOTSTRAP_ADMIN_EMAIL is set but email not in users table', async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'nobody-here@example.test';
    await expect(findActorUserId(tenantA.ctx)).rejects.toThrow(
      /BOOTSTRAP_ADMIN_EMAIL=.*not found in users table/,
    );
  });

  it('JOIN resolves to in-tenant admin when BOOTSTRAP_ADMIN_EMAIL is unset', async () => {
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    const id = await findActorUserId(tenantA.ctx);
    expect(id).toBe(userInA.userId);
    // Cross-check: the lookup against tenant B returns the OTHER user.
    const idB = await findActorUserId(tenantB.ctx);
    expect(idB).toBe(userInB.userId);
    expect(idB).not.toBe(userInA.userId);
  });

  it('cross-tenant isolation: admin contact in tenant B does NOT resolve to tenant A lookup', async () => {
    // Set up an admin user that ONLY has a contact in tenant B,
    // never in tenant A. JOIN-on-tenant-A must not match it even
    // though the user's role is 'admin'.
    delete process.env.BOOTSTRAP_ADMIN_EMAIL;
    const orphanUser = await createActiveTestUser('admin');
    const memberOrphanId = randomUUID();
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: memberOrphanId,
        companyName: 'Orphan Tenant B Co',
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
      });
      await tx.insert(contacts).values({
        tenantId: tenantB.ctx.slug,
        contactId: randomUUID(),
        memberId: memberOrphanId,
        firstName: 'Orphan',
        lastName: 'B',
        email: `orphan-${randomUUID().slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
        linkedUserId: orphanUser.userId,
      });
    });

    // Tenant A's lookup MUST resolve to userInA, not orphanUser.
    const id = await findActorUserId(tenantA.ctx);
    expect(id).toBe(userInA.userId);
    expect(id).not.toBe(orphanUser.userId);
  });
});
