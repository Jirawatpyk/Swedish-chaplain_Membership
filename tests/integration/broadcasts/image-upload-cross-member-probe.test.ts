/**
 * F119 T106 (FR-040, US3-AS3) — the `broadcast_cross_member_probe` row that
 * `authorizeImageOwner` writes when member A reaches for member B's draft
 * LANDS on live Neon, and lands with the right keys.
 *
 * Senior-tester review H3: until now this emit was proven only at the PORT —
 * every unit test asserts that a fake `AuditPort` was called. That cannot see
 * the thing that actually breaks here. The emit is made with a NULL tx (the
 * refusal changes no state), so `f7AuditAdapter` writes through the pool-global
 * `db` with no `app.current_tenant` GUC into an RLS + FORCE table, and
 * `safeAuditEmitTyped` swallows its own failures by design. Every layer above
 * the database can therefore look correct while nothing is written — the same
 * class the test-copy audit row is pinned for (`eblast-test-copy-audit-row`).
 *
 * Three things are asserted against the real database:
 *   1. the refusal is `not_found` — never 403, which would confirm the draft
 *      exists to someone who may not see it;
 *   2. EXACTLY ONE row, `broadcast_cross_member_probe`, carrying
 *      `probedMemberId` and NOT `member_id`. That spelling is load-bearing:
 *      `member_id` is the one key the 0009 `last_activity_at` trigger reads,
 *      so a refused probe carrying it would let an attacker guessing broadcast
 *      ids refresh the probed member's recency from the outside;
 *   3. member B's `members.last_activity_at` is byte-for-byte unchanged across
 *      the probe — the trigger's actual behaviour, not the payload's shape.
 *
 * Run by PATH: `pnpm test:integration tests/integration/broadcasts/image-upload-cross-member-probe.test.ts`
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { authorizeImageOwner } from '@/modules/broadcasts/application/use-cases/authorize-image-owner';
import { makeAuthorizeImageOwnerDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

describe('authorizeImageOwner — the cross-member probe row lands on live Neon', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  const memberA = randomUUID();
  const memberB = randomUUID();
  const draftOfB = randomUUID();
  const requestId = `xmember-probe-${randomUUID()}`;
  const OLD_ACTIVITY = new Date('2020-01-01T00:00:00.000Z');

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    const planId = `xmp-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Cross-member Probe Plan' },
        description: { en: 'eblast plan' },
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
        createdBy: admin.userId,
        updatedBy: admin.userId,
      } as unknown as typeof membershipPlans.$inferInsert);

      // Two members of the SAME tenant: RLS cannot separate them, so the
      // ownership check is the only thing standing between them.
      await tx.insert(members).values([
        {
          tenantId: tenant.ctx.slug,
          memberId: memberA,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Prober Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        },
        {
          tenantId: tenant.ctx.slug,
          memberId: memberB,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Victim Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
        },
      ] as unknown as Array<typeof members.$inferInsert>);

      await tx
        .update(members)
        .set({ lastActivityAt: OLD_ACTIVITY })
        .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberB)));

      // B's own unsent draft — the row A will reach for.
      await tx.execute(sql`
        INSERT INTO broadcasts (
          tenant_id, broadcast_id, requested_by_member_id,
          requested_by_member_plan_id_snapshot, submitted_by_user_id,
          actor_role, subject, body_html, body_source, from_name,
          reply_to_email, segment_type, segment_params,
          custom_recipient_emails, estimated_recipient_count, status,
          retention_years, created_at, updated_at
        ) VALUES (
          ${tenant.ctx.slug}, ${draftOfB}::uuid, ${memberB}::uuid,
          ${planId}, ${randomUUID()}::uuid,
          ${'member_self_service'}, ${'B private draft'}, ${'<p>mine</p>'}, ${'plain'},
          ${'Victim Co via Test Chamber'}, ${'reply@example.com'},
          ${'all_members'}, NULL, NULL, ${0}, ${'draft'}::broadcast_status,
          ${5}, now(), now()
        )
      `);
    });
  }, 180_000);

  afterAll(async () => {
    // `audit_log` is append-only (DELETE denied by grant, security.md T-13);
    // the probe row stays under the throwaway tenant slug, like every other
    // integration suite's audit rows. The tenant helper removes the
    // broadcasts / members / plan rows this suite inserted.
    await tenant.cleanup().catch(() => {});
  }, 180_000);

  it(
    "refuses with not_found, writes exactly one probe row keyed probedMemberId, and leaves B's recency alone",
    async () => {
      const before = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ lastActivityAt: members.lastActivityAt })
          .from(members)
          .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberB))),
      );
      expect(new Date(before[0]!.lastActivityAt as Date).getTime()).toBe(
        OLD_ACTIVITY.getTime(),
      );

      const result = await authorizeImageOwner(
        makeAuthorizeImageOwnerDeps(tenant.ctx.slug),
        {
          tenantId: tenant.ctx.slug,
          owner: { kind: 'broadcast', id: draftOfB },
          actor: { kind: 'member', memberId: memberA },
          actorUserId: admin.userId,
          requestId,
        },
      );

      // Never 403 — a 403 would confirm the draft exists.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('not_found');

      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId)));
      expect(
        rows,
        'the null-tx emit goes through the pool-global db into an RLS+FORCE table and swallows its own failures — this is the only place it is proven to land',
      ).toHaveLength(1);

      const row = rows[0]!;
      expect(row.eventType).toBe('broadcast_cross_member_probe');
      const payload = row.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        probedMemberId: memberA,
        probedBroadcastId: draftOfB,
        operation: 'image_upload',
      });

      // Asserted against the database's own key test, not a JS property read:
      // this is the exact predicate the 0009 trigger uses.
      const keyed = (await db.execute(sql`
        SELECT jsonb_exists(payload, 'probedMemberId') AS has_probed,
               jsonb_exists(payload, 'member_id')      AS has_member_id
          FROM audit_log
         WHERE tenant_id = ${tenant.ctx.slug} AND request_id = ${requestId}
      `)) as unknown as Array<{ has_probed: boolean; has_member_id: boolean }>;
      expect(keyed).toHaveLength(1);
      expect(keyed[0]!.has_probed).toBe(true);
      expect(
        keyed[0]!.has_member_id,
        'a REFUSED probe carrying snake member_id would let an attacker refresh the probed member’s last_activity_at from the outside',
      ).toBe(false);

      const after = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ lastActivityAt: members.lastActivityAt })
          .from(members)
          .where(and(eq(members.tenantId, tenant.ctx.slug), eq(members.memberId, memberB))),
      );
      expect(new Date(after[0]!.lastActivityAt as Date).getTime()).toBe(
        OLD_ACTIVITY.getTime(),
      );
    },
    180_000,
  );
});
