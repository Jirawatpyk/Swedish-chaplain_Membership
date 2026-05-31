/**
 * F9 US6 (T087) — GDPR export authorisation + attribution (live Neon).
 *
 * A member may export only their OWN data (FR-032); an admin may export on a
 * member's behalf (FR-031), and the `data_export_requested` audit row is
 * attributed to the admin with `on_behalf=true`. A self-service request is
 * attributed to the member with `on_behalf=false`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { requestDataExport, makeRequestDataExportDeps } from '@/modules/insights';
import { exportJobs } from '@/modules/insights/infrastructure/db/schema-insights';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('F9 GDPR export — authz + attribution (T087)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const subject = randomUUID();
  const otherMember = randomUUID();
  const memberUserId = randomUUID();

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 120_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(exportJobs).where(eq(exportJobs.tenantId, slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('member cannot export another member — forbidden, no job created', async () => {
    const r = await requestDataExport(
      { subjectMemberId: otherMember },
      {
        actorUserId: memberUserId,
        actorRole: 'member',
        actorMemberId: subject,
        requesterLocale: 'en',
        requestId: `authz-forbid-${randomUUID()}`,
      },
      tenant.ctx,
      makeRequestDataExportDeps(tenant.ctx.slug),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');

    const jobs = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.subjectMemberId, otherMember)),
    );
    expect(jobs.length).toBe(0);
  }, 60_000);

  it('member self-service request is attributed to the member with on_behalf=false', async () => {
    const r = await requestDataExport(
      { subjectMemberId: subject },
      {
        actorUserId: memberUserId,
        actorRole: 'member',
        actorMemberId: subject,
        requesterLocale: 'th',
        requestId: `authz-self-${randomUUID()}`,
      },
      tenant.ctx,
      makeRequestDataExportDeps(tenant.ctx.slug),
    );
    expect(r.ok).toBe(true);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'data_export_requested'),
          ),
        ),
    );
    const selfRow = rows.find(
      (a) => (a.payload as { subject_member_id?: string } | null)?.subject_member_id === subject,
    );
    expect(selfRow).toBeDefined();
    expect(selfRow!.actorUserId).toBe(memberUserId);
    expect((selfRow!.payload as { on_behalf?: boolean }).on_behalf).toBe(false);
    // Requester locale captured on the job for the worker README (FR-029).
    const job = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(exportJobs).where(eq(exportJobs.subjectMemberId, subject)),
    );
    expect(job[0]?.requesterLocale).toBe('th');
  }, 60_000);

  it('admin on-behalf request is attributed to the admin with on_behalf=true', async () => {
    const onBehalfSubject = randomUUID();
    const r = await requestDataExport(
      { subjectMemberId: onBehalfSubject },
      {
        actorUserId: admin.userId,
        actorRole: 'admin',
        actorMemberId: null,
        requesterLocale: 'sv',
        requestId: `authz-onbehalf-${randomUUID()}`,
      },
      tenant.ctx,
      makeRequestDataExportDeps(tenant.ctx.slug),
    );
    expect(r.ok).toBe(true);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'data_export_requested'),
          ),
        ),
    );
    const onBehalfRow = rows.find(
      (a) =>
        (a.payload as { subject_member_id?: string } | null)?.subject_member_id ===
        onBehalfSubject,
    );
    expect(onBehalfRow).toBeDefined();
    expect(onBehalfRow!.actorUserId).toBe(admin.userId);
    expect((onBehalfRow!.payload as { on_behalf?: boolean }).on_behalf).toBe(true);
  }, 60_000);
});
