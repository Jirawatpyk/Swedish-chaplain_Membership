/**
 * F119 T011 (owner) · T047 (PR-2 extends) — two-tenant RLS probes on the
 * tables this feature creates or starts writing into (Constitution I.3,
 * Review-Gate blocker): reads AND writes refused in BOTH directions.
 *
 * PR-1 (migration 0304):
 *   - `broadcast_images`            — new table, RLS ENABLE + FORCE + the 0064 policy
 *   - `tenant_broadcast_settings`   — pre-existing (0131, RLS since 0166), but 0304
 *     turns it into a tenant-authored WRITE surface (brand colour + postal
 *     address) and T021 registers it in `SCOPED_TABLES`, so it takes the same
 *     probe as a new table.
 * PR-2 (migration 0308, T047): `broadcast_versions` + `broadcast_member_decisions`.
 *
 * Fixtures are inserted through the schema-owner `db` (BYPASSRLS); every
 * probe runs under `runInTenant`, which is the only way application code
 * reaches these tables. One author per file — T047 extends, never recreates.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import {
  broadcastImages,
  broadcastMemberDecisions,
  broadcasts,
  broadcastVersions,
  tenantBroadcastSettings,
  type NewBroadcastImageRow,
  type NewBroadcastMemberDecisionRow,
  type NewBroadcastVersionRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('F119 tenant isolation — broadcast_images + tenant_broadcast_settings brand columns', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const aImageId = randomUUID();
  const bImageId = randomUUID();
  const aOwnerId = randomUUID();
  const bOwnerId = randomUUID();

  const imageRow = (tenantId: string, id: string, ownerId: string): NewBroadcastImageRow => ({
    tenantId,
    id,
    ownerKind: 'broadcast',
    ownerId,
    contentHash: `sha256-${id}`,
    blobUrl: `https://blob.example/${tenantId}/${id}.png`,
    blobKey: `broadcasts/images/${tenantId}/${id}.png`,
    mimeType: 'image/png',
    byteSize: 1234,
    uploadedByUserId: randomUUID(),
  });

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    await db.insert(broadcastImages).values(imageRow(tenantA.ctx.slug, aImageId, aOwnerId));
    await db.insert(broadcastImages).values(imageRow(tenantB.ctx.slug, bImageId, bOwnerId));
    await db
      .insert(tenantBroadcastSettings)
      .values({ tenantId: tenantA.ctx.slug, brandPrimaryColor: '#10487a', brandPostalAddress: 'A street' })
      .onConflictDoUpdate({
        target: tenantBroadcastSettings.tenantId,
        set: { brandPrimaryColor: '#10487a', brandPostalAddress: 'A street' },
      });
    await db
      .insert(tenantBroadcastSettings)
      .values({ tenantId: tenantB.ctx.slug, brandPrimaryColor: '#b04a00', brandPostalAddress: 'B street' })
      .onConflictDoUpdate({
        target: tenantBroadcastSettings.tenantId,
        set: { brandPrimaryColor: '#b04a00', brandPostalAddress: 'B street' },
      });
  });

  afterAll(async () => {
    await db.delete(broadcastImages).where(eq(broadcastImages.tenantId, tenantA.ctx.slug));
    await db.delete(broadcastImages).where(eq(broadcastImages.tenantId, tenantB.ctx.slug));
    await db.delete(tenantBroadcastSettings).where(eq(tenantBroadcastSettings.tenantId, tenantA.ctx.slug));
    await db.delete(tenantBroadcastSettings).where(eq(tenantBroadcastSettings.tenantId, tenantB.ctx.slug));
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  describe('broadcast_images — tenant B cannot read or write tenant A rows (and vice versa)', () => {
    it('A cannot SELECT B by id; B cannot SELECT A by id', async () => {
      const seenByA = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(broadcastImages).where(eq(broadcastImages.id, bImageId)),
      );
      const seenByB = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(broadcastImages).where(eq(broadcastImages.id, aImageId)),
      );
      expect(seenByA).toEqual([]);
      expect(seenByB).toEqual([]);
    });

    it('an unfiltered SELECT sees only the caller\'s rows', async () => {
      const rows = await runInTenant(tenantA.ctx, (tx) => tx.select().from(broadcastImages));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.tenantId === tenantA.ctx.slug)).toBe(true);
    });

    it('A UPDATE on B\'s row → 0 rows; B\'s row unchanged', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx.update(broadcastImages).set({ deletedAt: new Date() }).where(eq(broadcastImages.id, bImageId)).returning(),
      );
      expect(updated).toEqual([]);
      const b = await db.select().from(broadcastImages).where(eq(broadcastImages.id, bImageId));
      expect(b[0]?.deletedAt).toBeNull();
    });

    it('B DELETE on A\'s row → 0 rows; A\'s row still there', async () => {
      const deleted = await runInTenant(tenantB.ctx, (tx) =>
        tx.delete(broadcastImages).where(eq(broadcastImages.id, aImageId)).returning(),
      );
      expect(deleted).toEqual([]);
      const a = await db.select().from(broadcastImages).where(eq(broadcastImages.id, aImageId));
      expect(a).toHaveLength(1);
    });

    it('A INSERT carrying B\'s tenant_id → refused by WITH CHECK', async () => {
      await expect(
        runInTenant(tenantA.ctx, (tx) =>
          tx.insert(broadcastImages).values(imageRow(tenantB.ctx.slug, randomUUID(), bOwnerId)),
        ),
      ).rejects.toThrow();
    });
  });

  describe('tenant_broadcast_settings brand columns — B cannot read or write A (and vice versa)', () => {
    it('A cannot SELECT B\'s brand row; B cannot SELECT A\'s', async () => {
      const seenByA = await runInTenant(tenantA.ctx, (tx) =>
        tx.select().from(tenantBroadcastSettings).where(eq(tenantBroadcastSettings.tenantId, tenantB.ctx.slug)),
      );
      const seenByB = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(tenantBroadcastSettings).where(eq(tenantBroadcastSettings.tenantId, tenantA.ctx.slug)),
      );
      expect(seenByA).toEqual([]);
      expect(seenByB).toEqual([]);
    });

    it('A UPDATE of B\'s brand colour → 0 rows; B keeps its colour', async () => {
      const updated = await runInTenant(tenantA.ctx, (tx) =>
        tx
          .update(tenantBroadcastSettings)
          .set({ brandPrimaryColor: '#000000' })
          .where(eq(tenantBroadcastSettings.tenantId, tenantB.ctx.slug))
          .returning(),
      );
      expect(updated).toEqual([]);
      const b = await db
        .select()
        .from(tenantBroadcastSettings)
        .where(eq(tenantBroadcastSettings.tenantId, tenantB.ctx.slug));
      expect(b[0]?.brandPrimaryColor).toBe('#b04a00');
    });

    it('B UPDATE of A\'s postal address → 0 rows; A keeps its address', async () => {
      const updated = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .update(tenantBroadcastSettings)
          .set({ brandPostalAddress: 'hijacked' })
          .where(eq(tenantBroadcastSettings.tenantId, tenantA.ctx.slug))
          .returning(),
      );
      expect(updated).toEqual([]);
      const a = await db
        .select()
        .from(tenantBroadcastSettings)
        .where(and(eq(tenantBroadcastSettings.tenantId, tenantA.ctx.slug)));
      expect(a[0]?.brandPostalAddress).toBe('A street');
    });

    it('the brand_primary_color CHECK refuses a value that is not #RRGGBB', async () => {
      // Drizzle wraps the driver error ("Failed query: …") and keeps the
      // Postgres message on `cause` — read both so the constraint NAME is
      // what is asserted, not the wrapper.
      let thrown: unknown = null;
      try {
        await runInTenant(tenantA.ctx, (tx) =>
          tx
            .update(tenantBroadcastSettings)
            .set({ brandPrimaryColor: 'red' })
            .where(eq(tenantBroadcastSettings.tenantId, tenantA.ctx.slug)),
        );
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const e = thrown as Error & { cause?: { message?: string } };
      const text = `${e.message}\n${e.cause?.message ?? ''}`;
      expect(text).toMatch(/tenant_broadcast_settings_brand_primary_color_check/);
    });
  });

  // --- T047 (PR-2, migration 0308) -----------------------------------------
  describe('tenant B cannot read or write tenant A\'s versions or decisions', () => {
    // One E-Blast per tenant, awaiting the member, with one sent version and
    // one decision on it. The rows are the FK chain the tables require.
    const seeded = {
      a: { broadcastId: randomUUID(), versionId: randomUUID(), decisionId: randomUUID() },
      b: { broadcastId: randomUUID(), versionId: randomUUID(), decisionId: randomUUID() },
    };
    const versionRow = (tenantId: string, s: typeof seeded.a): NewBroadcastVersionRow => ({
      tenantId,
      id: s.versionId,
      broadcastId: s.broadcastId,
      versionNo: 1,
      subject: `v1 ${tenantId}`,
      bodyHtml: '<p>v1</p>',
      bodySource: 'v1',
      authoredByUserId: randomUUID(),
      authoredByRole: 'admin_proxy',
      sentToMemberAt: new Date(),
    });
    const decisionRow = (tenantId: string, s: typeof seeded.a): NewBroadcastMemberDecisionRow => ({
      tenantId,
      id: s.decisionId,
      broadcastId: s.broadcastId,
      versionId: s.versionId,
      round: 1,
      decision: 'changes_requested',
      reason: `reason ${tenantId}`,
      decidedByUserId: randomUUID(),
      decidedByContactId: randomUUID(),
    });

    beforeAll(async () => {
      for (const [tenant, s] of [
        [tenantA, seeded.a],
        [tenantB, seeded.b],
      ] as const) {
        await db.insert(broadcasts).values({
          tenantId: tenant.ctx.slug,
          broadcastId: s.broadcastId,
          requestedByMemberId: randomUUID(),
          requestedByMemberPlanIdSnapshot: 'plan-t047',
          submittedByUserId: randomUUID(),
          actorRole: 'member_self_service',
          subject: 'T047',
          bodyHtml: '<p>b</p>',
          bodySource: 'b',
          fromName: 'Chamber',
          replyToEmail: 'reply@example.com',
          segmentType: 'all_members',
          estimatedRecipientCount: 10,
          status: 'awaiting_member_approval',
          submittedAt: new Date(),
          currentRound: 1,
        });
        await db.insert(broadcastVersions).values(versionRow(tenant.ctx.slug, s));
        await db.insert(broadcastMemberDecisions).values(decisionRow(tenant.ctx.slug, s));
      }
    });

    // Tenant ids a SELECT by id returns, per table, under one tenant's context.
    const readTenants = (self: TestTenant, s: typeof seeded.a) =>
      runInTenant(self.ctx, async (tx) => ({
        version: (await tx.select().from(broadcastVersions).where(eq(broadcastVersions.id, s.versionId))).map(
          (r) => r.tenantId,
        ),
        decision: (
          await tx.select().from(broadcastMemberDecisions).where(eq(broadcastMemberDecisions.id, s.decisionId))
        ).map((r) => r.tenantId),
        unfiltered: [
          ...(await tx.select().from(broadcastVersions)).map((r) => r.tenantId),
          ...(await tx.select().from(broadcastMemberDecisions)).map((r) => r.tenantId),
        ],
      }));

    it('each tenant reads its own version and decision, never the other\'s (both directions)', async () => {
      for (const [self, own, foreign] of [
        [tenantA, seeded.a, seeded.b],
        [tenantB, seeded.b, seeded.a],
      ] as const) {
        // positive control — separates RLS from a missing GRANT
        const mine = await readTenants(self, own);
        expect(mine.version).toEqual([self.ctx.slug]);
        expect(mine.decision).toEqual([self.ctx.slug]);
        const theirs = await readTenants(self, foreign);
        expect({ version: theirs.version, decision: theirs.decision }).toEqual({ version: [], decision: [] });
        expect(theirs.unfiltered.length).toBeGreaterThanOrEqual(2);
        expect(theirs.unfiltered.every((t) => t === self.ctx.slug)).toBe(true);
      }
    });

    it('broadcast_versions — a cross-tenant UPDATE touches 0 rows in both directions', async () => {
      for (const [self, foreign] of [
        [tenantA, seeded.b],
        [tenantB, seeded.a],
      ] as const) {
        const updated = await runInTenant(self.ctx, (tx) =>
          tx
            .update(broadcastVersions)
            .set({ noteToMember: 'hijacked' })
            .where(eq(broadcastVersions.id, foreign.versionId))
            .returning(),
        );
        expect(updated).toEqual([]);
        const row = await db.select().from(broadcastVersions).where(eq(broadcastVersions.id, foreign.versionId));
        expect(row[0]?.noteToMember).toBeNull();
      }
    });

    it('broadcast_member_decisions — a cross-tenant UPDATE touches 0 rows in both directions (RLS filters before the append-only trigger)', async () => {
      for (const [self, other, foreign] of [
        [tenantA, tenantB, seeded.b],
        [tenantB, tenantA, seeded.a],
      ] as const) {
        const updated = await runInTenant(self.ctx, (tx) =>
          tx
            .update(broadcastMemberDecisions)
            .set({ reason: 'hijacked' })
            .where(eq(broadcastMemberDecisions.id, foreign.decisionId))
            .returning(),
        );
        expect(updated).toEqual([]);
        const row = await db
          .select()
          .from(broadcastMemberDecisions)
          .where(eq(broadcastMemberDecisions.id, foreign.decisionId));
        expect(row[0]?.reason).toBe(`reason ${other.ctx.slug}`);
      }
    });

    it('an INSERT carrying the other tenant\'s tenant_id is refused by WITH CHECK, both tables, both directions', async () => {
      for (const [self, other, foreign] of [
        [tenantA, tenantB, seeded.b],
        [tenantB, tenantA, seeded.a],
      ] as const) {
        // fresh ids on the other tenant's real E-Blast, so a key collision can
        // never be the refusal that is observed
        const fresh = { ...foreign, versionId: randomUUID(), decisionId: randomUUID() };
        for (const insert of [
          () => runInTenant(self.ctx, (tx) => tx.insert(broadcastVersions).values({ ...versionRow(other.ctx.slug, fresh), versionNo: 2 })),
          () => runInTenant(self.ctx, (tx) => tx.insert(broadcastMemberDecisions).values(decisionRow(other.ctx.slug, fresh))),
        ]) {
          let thrown: unknown = null;
          try {
            await insert();
          } catch (e) {
            thrown = e;
          }
          expect(thrown).not.toBeNull();
          expect(errorChainMessage(thrown)).toMatch(/row-level security/);
        }
      }
    });
  });
});
