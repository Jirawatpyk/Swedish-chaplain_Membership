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
 * PR-2 (migration 0305, T047): `broadcast_versions` + `broadcast_member_decisions`.
 *
 * Fixtures are inserted through the schema-owner `db` (BYPASSRLS); every
 * probe runs under `runInTenant`, which is the only way application code
 * reaches these tables. One author per file — T047 extends, never recreates.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import {
  broadcastImages,
  tenantBroadcastSettings,
  type NewBroadcastImageRow,
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
});
