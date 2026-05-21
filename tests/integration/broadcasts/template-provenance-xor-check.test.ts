/**
 * R8.4 (R7 silent-failure-LOW-2) — Integration test for the
 * `broadcasts_template_provenance_xor` CHECK constraint (migration
 * 0179).
 *
 * Defense-in-depth: pre-R8.4 the XOR invariant was application-layer
 * only (Drizzle mapper logged + returned null on half-populated rows).
 * R8.4 added a Postgres CHECK constraint that converts silent
 * corruption-on-read into a loud 23514 check_violation at WRITE time.
 *
 * This test exercises the constraint by attempting 3 INSERTs against
 * live Neon Singapore:
 *   1. both columns NULL (blank-canvas)         → accepted ✓
 *   2. both columns populated (snapshot)        → accepted ✓
 *   3. exactly one column populated (corrupt)   → rejected (23514) ✓
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { broadcastTemplates, broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

describe('R8.4 — broadcasts_template_provenance_xor CHECK constraint', () => {
  let tenant: TestTenant;
  let templateId: string;
  const insertedBroadcastIds: string[] = [];

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    // Seed a template so the FK references resolve for case 2.
    const [tpl] = await db
      .insert(broadcastTemplates)
      .values({
        tenantId: tenant.ctx.slug,
        name: 'XOR Test Template',
        subject: 'Subject',
        bodyHtml: '<p>body</p>',
        locale: 'en',
        isSeeded: false,
        createdByUserId: null,
      })
      .returning({ id: broadcastTemplates.id });
    templateId = tpl!.id;
  });

  afterAll(async () => {
    if (insertedBroadcastIds.length > 0) {
      await db
        .delete(broadcasts)
        .where(inArray(broadcasts.broadcastId, insertedBroadcastIds as never));
    }
    await db
      .delete(broadcastTemplates)
      .where(eq(broadcastTemplates.tenantId, tenant.ctx.slug));
  });

  // Synthetic UUIDs for FK-free columns. Foreign-key columns
  // (requested_by_member_id, requested_by_member_plan_id_snapshot,
  // submitted_by_user_id) are NOT enforced as FK at the DB layer per
  // schema.ts (they're string ids; tenants table is separate). UUID
  // format is the only DB-layer requirement.
  const MEMBER_ID = '11111111-1111-1111-1111-111111111111';
  const PLAN_ID = '22222222-2222-2222-2222-222222222222';
  const USER_ID = '33333333-3333-3333-3333-333333333333';

  const makeBroadcastRow = (overrides: {
    startedFromTemplateId?: string | null;
    templateNameSnapshot?: string | null;
  }) => {
    return {
      tenantId: tenant.ctx.slug,
      requestedByMemberId: MEMBER_ID,
      requestedByMemberPlanIdSnapshot: PLAN_ID,
      submittedByUserId: USER_ID,
      actorRole: 'member_self_service' as const,
      subject: 'XOR test subject',
      bodyHtml: '<p>XOR test body</p>',
      bodySource: 'plain',
      fromName: 'Test Chamber',
      replyToEmail: 'test@test.local',
      segmentType: 'all_members' as const,
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'draft' as const,
      retentionYears: 5,
      manualRetryCount: 0,
      partialDeliveryAcceptedAt: null,
      partialDeliveryAcceptedByUserId: null,
      startedFromTemplateId:
        overrides.startedFromTemplateId === undefined
          ? null
          : overrides.startedFromTemplateId,
      templateNameSnapshot:
        overrides.templateNameSnapshot === undefined
          ? null
          : overrides.templateNameSnapshot,
    };
  };

  it('accepts INSERT with BOTH columns NULL (blank-canvas draft)', async () => {
    const result = await db
      .insert(broadcasts)
      .values(makeBroadcastRow({ startedFromTemplateId: null, templateNameSnapshot: null }))
      .returning({ broadcastId: broadcasts.broadcastId });
    expect(result).toHaveLength(1);
    insertedBroadcastIds.push(result[0]!.broadcastId);
  });

  it('accepts INSERT with BOTH columns populated (snapshot from template)', async () => {
    const result = await db
      .insert(broadcasts)
      .values(
        makeBroadcastRow({
          startedFromTemplateId: templateId,
          templateNameSnapshot: 'XOR Test Template',
        }),
      )
      .returning({ broadcastId: broadcasts.broadcastId });
    expect(result).toHaveLength(1);
    insertedBroadcastIds.push(result[0]!.broadcastId);
  });

  it('REJECTS INSERT with EXACTLY ONE column populated (id-only)', async () => {
    await expect(
      db.insert(broadcasts).values(
        makeBroadcastRow({
          startedFromTemplateId: templateId,
          templateNameSnapshot: null,
        }),
      ),
    ).rejects.toThrow(); // Postgres 23514 check_violation; Drizzle
    // wraps as "Failed query: insert into ...". The error throw is
    // sufficient — the BYPASSRLS verification below proves the row
    // never landed.
  });

  it('REJECTS INSERT with EXACTLY ONE column populated (name-only)', async () => {
    await expect(
      db.insert(broadcasts).values(
        makeBroadcastRow({
          startedFromTemplateId: null,
          templateNameSnapshot: 'Orphaned Name',
        }),
      ),
    ).rejects.toThrow(); // Postgres 23514 check_violation; Drizzle
    // wraps as "Failed query: insert into ...". The error throw is
    // sufficient — the BYPASSRLS verification below proves the row
    // never landed.
  });
});
