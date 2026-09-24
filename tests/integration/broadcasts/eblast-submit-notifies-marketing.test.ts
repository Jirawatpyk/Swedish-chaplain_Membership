/**
 * F119 T123 — every marketing user is notified on submit, the admins when the
 * tenant has none, and an empty roster pages (US5-AS1, FR-021, FR-021a;
 * contracts/dashboard-and-notifications.md §§ 3, 3.1), against LIVE Postgres
 * (Neon `dev`).
 *
 * The REAL submit (`makeSubmitBroadcastDeps` + the REAL
 * `makeMarketingDirectory`) writes REAL `notifications_outbox` rows inside the
 * REAL submit transaction. One seam is stubbed, disclosed: the cross-tenant
 * `users` read behind the roster (`listActiveUsersByRole`). `users` has no
 * `tenant_id` and the shared `dev` branch always holds active admins and
 * marketing users from other suites, so "a tenant with no marketing user" and
 * "neither" are unreachable there, and "one row each" would fan out to every
 * active marketing login on the branch. The role derivation, the fallback and
 * the empty-roster counter all run for real above that read.
 *
 * With `FEATURE_EBLAST_MEMBER_APPROVAL` in any state the rows are written
 * `pending` — the enqueue is unconditional; the drainer is where the flag
 * lives (T152a).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const roster = vi.hoisted(() => ({
  active: {} as Partial<Record<string, Array<{ id: string; email: string }>>>,
  queried: [] as Array<readonly string[]>,
}));
vi.mock('@/modules/auth/infrastructure/db/active-users-by-role-repo', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/auth/infrastructure/db/active-users-by-role-repo')>();
  return {
    ...real,
    listActiveUsersByRole: vi.fn(async (roles: readonly string[]) => {
      roster.queried.push([...roles]);
      return roles.flatMap((r) => roster.active[r] ?? []);
    }),
  };
});

import { runInTenant } from '@/lib/db';
import { broadcastsMetrics } from '@/lib/metrics';
import { makeMarketingDirectory } from '@/lib/broadcast-marketing-deps';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { submitBroadcast, type SubmitBroadcastInput } from '@/modules/broadcasts/application/use-cases/submit-broadcast';
import { makeSubmitBroadcastDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { eblastNotificationOutbox } from '@/modules/broadcasts/infrastructure/email-transactional-bridge';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const MARKETER_A = { id: randomUUID(), email: 'marketing-a@t123.example' };
const MARKETER_B = { id: randomUUID(), email: 'marketing-b@t123.example' };
const ADMIN = { id: randomUUID(), email: 'admin@t123.example' };
const SUPER = { id: randomUUID(), email: 'super@t123.example' };

describe('F119 T123 — the submit hands off to marketing, one outbox row per recipient (live Neon)', () => {
  let tenant: TestTenant;
  let portalUser: TestUser;
  const planId = `plan-f119-t123-${randomUUID().slice(0, 8)}`;

  /**
   * The test plan allows ONE E-Blast a year (`test-benefit-matrix.ts`), and the
   * submit rate limit is per member — so every submit gets its own member.
   */
  const freshMember = async () =>
    (await seedPortalMemberWithContact(tenant, planId, { linkedUserId: portalUser.userId, companyName: 'T123 Co' })).memberId;
  const input = (memberId: string): SubmitBroadcastInput => ({
    memberId,
    submittedByUserId: portalUser.userId,
    actorRole: 'member_self_service',
    tenantDisplayName: 'Test Chamber',
    memberDisplayName: 'T123 Co',
    subject: 'SECRET-SUBJECT-t123',
    bodySource: 'plain',
    bodyHtml: '<p>SECRET-BODY-t123</p>',
    segment: { kind: 'all_members' },
    scheduledFor: null,
    requestId: null,
  });
  const submit = async () => {
    const r = await submitBroadcast(makeSubmitBroadcastDeps(tenant.ctx.slug, makeMarketingDirectory(tenant.ctx.slug)), input(await freshMember()));
    if (!r.ok) throw new Error(`submit refused: ${r.error.kind}`);
    return r.value.broadcastId;
  };
  const outboxFor = (broadcastId: string) =>
    runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, tenant.ctx.slug),
            sql`${notificationsOutbox.contextData}->>'broadcastId' = ${broadcastId}`,
          ),
        ),
    );

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    portalUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, portalUser.userId, planId);
    // A member with a primary contact, so the all-members segment has a recipient.
    await seedPortalMemberWithContact(tenant, planId, { companyName: 'Recipient Co' });
  }, 120_000);

  beforeEach(() => {
    roster.active = {};
    roster.queried = [];
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (portalUser) await deleteTestUser(portalUser).catch(() => {});
  });

  it('with marketing users: one pending eblast_submitted_marketing row EACH, ids only, and the admins are not asked', async () => {
    roster.active = { marketing: [MARKETER_A, MARKETER_B], admin: [ADMIN], super_admin: [SUPER] };
    const broadcastId = await submit();

    const rows = await outboxFor(broadcastId);
    expect(rows.map((r) => r.toEmail).sort()).toEqual([MARKETER_A.email, MARKETER_B.email]);
    for (const row of rows) {
      expect(row).toMatchObject({ notificationType: 'eblast_submitted_marketing', status: 'pending', attempts: 0, lastError: null, locale: 'en' });
      expect(Object.keys(row.contextData as object).sort()).toEqual(['broadcastId', 'recipientUserId', 'tenantId']);
    }
    expect(JSON.stringify(rows.map((r) => r.contextData))).not.toContain('SECRET');
    expect(roster.queried).toEqual([['marketing']]);
  });

  it('with no ACTIVE marketing user: the admins (every broadcasts.write holder) instead', async () => {
    roster.active = { admin: [ADMIN], super_admin: [SUPER] };
    const broadcastId = await submit();
    expect((await outboxFor(broadcastId)).map((r) => r.toEmail).sort()).toEqual([ADMIN.email, SUPER.email].sort());
  });

  it('with neither: the submit still succeeds, nothing is enqueued, and broadcasts_no_marketing_recipient_total is incremented', async () => {
    const counter = vi.spyOn(broadcastsMetrics, 'noMarketingRecipient');
    const broadcastId = await submit();
    expect(await outboxFor(broadcastId)).toEqual([]);
    expect(counter).toHaveBeenCalledWith(tenant.ctx.slug);
    expect(counter).toHaveBeenCalledTimes(1);
  });

  it('the rows ride the submit transaction: a failure AFTER the enqueue leaves no outbox row and no submitted broadcast', async () => {
    roster.active = { marketing: [MARKETER_A] };
    const draftId = randomUUID();
    const deps = {
      ...makeSubmitBroadcastDeps(tenant.ctx.slug, makeMarketingDirectory(tenant.ctx.slug)),
      eblastOutbox: {
        async enqueueInTx(tx: unknown, t: Parameters<typeof eblastNotificationOutbox.enqueueInTx>[1], r: Parameters<typeof eblastNotificationOutbox.enqueueInTx>[2]) {
          await eblastNotificationOutbox.enqueueInTx(tx, t, r); // the REAL insert…
          throw new Error('fault after the enqueue'); // …then the tx fails
        },
      },
    };
    const r = await submitBroadcast(deps, { ...input(await freshMember()), draftId });
    expect(r.ok ? 'submitted' : r.error.kind).toBe('submit.server_error');
    expect(await outboxFor(draftId)).toEqual([]);
    const row = await runInTenant(tenant.ctx, (tx) => tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, draftId)));
    expect(row).toEqual([]);
  });

  it('the outbox rows are tenant-scoped: another tenant cannot see them', async () => {
    roster.active = { marketing: [MARKETER_A] };
    const broadcastId = await submit();
    const other = await createTestTenant('test-chamber');
    try {
      const seen = await runInTenant(other.ctx, (tx) =>
        tx.select().from(notificationsOutbox).where(sql`${notificationsOutbox.contextData}->>'broadcastId' = ${broadcastId}`),
      );
      expect(seen).toEqual([]);
      expect(await outboxFor(broadcastId)).toHaveLength(1);
    } finally {
      await other.cleanup().catch(() => {});
    }
  });
});
