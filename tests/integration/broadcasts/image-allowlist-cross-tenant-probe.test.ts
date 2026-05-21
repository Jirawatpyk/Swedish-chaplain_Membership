/**
 * T065 (F7.1a US2 / Principle I Review-Gate) — Cross-tenant probe for
 * `tenant_image_source_allowlist`.
 *
 * Validates DB-layer RLS+FORCE (migration 0166 + grants 0172) prevents
 * tenant B from reading, writing, or removing tenant A's allowlist
 * rows when running under `runInTenant(tenantB.ctx)`. Mirrors the
 * F7.1a US1 pagination probe pattern (T036) — uses `tx` directly to
 * exercise the DB-layer policy rather than going through repos
 * (repos rely on the SAME RLS+FORCE chain; what we're verifying here
 * IS the chain).
 *
 * 4 probe cases per data-model.md § 6:
 *   READ      — tenant B cannot SELECT tenant A rows
 *   UPDATE    — tenant B cannot UPDATE tenant A rows
 *   DELETE    — tenant B cannot DELETE tenant A rows
 *   INSERT    — tenant B cannot INSERT a row with tenantId=tenantA
 *
 * Runs against live Neon Singapore per CLAUDE.md "Commands" §
 * `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { tenantImageSourceAllowlist } from '@/modules/broadcasts/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { manageImageAllowlist } from '@/modules/broadcasts/application/use-cases/manage-image-allowlist';
import { makeManageImageAllowlistDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('F7.1a image-allowlist cross-tenant probe — REVIEW-GATE BLOCKER (T065)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const A_HOST = 'private-a.example.com';
  const B_HOST = 'private-b.example.com';

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed one allowlist row per tenant via the schema-owner `db`
    // client which BYPASSES RLS — the test setup needs cross-tenant
    // write access (same pattern as F7.1a US1 pagination probe T036).
    await db.insert(tenantImageSourceAllowlist).values([
      {
        tenantId: tenantA.ctx.slug,
        hostname: A_HOST,
        isDefault: false,
        createdByUserId: null,
      },
      {
        tenantId: tenantB.ctx.slug,
        hostname: B_HOST,
        isDefault: false,
        createdByUserId: null,
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(tenantImageSourceAllowlist)
      .where(
        inArray(tenantImageSourceAllowlist.tenantId, [
          tenantA.ctx.slug,
          tenantB.ctx.slug,
        ]),
      );
  });

  it('READ: tenant B cannot SELECT tenant A allowlist rows', async () => {
    const rows = await runInTenant(tenantB.ctx, async (tx) =>
      tx
        .select()
        .from(tenantImageSourceAllowlist)
        .where(eq(tenantImageSourceAllowlist.tenantId, tenantA.ctx.slug)),
    );
    expect(rows).toEqual([]);
  });

  it('READ: tenant A cannot SELECT tenant B allowlist rows', async () => {
    const rows = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .select()
        .from(tenantImageSourceAllowlist)
        .where(eq(tenantImageSourceAllowlist.tenantId, tenantB.ctx.slug)),
    );
    expect(rows).toEqual([]);
  });

  it('UPDATE: tenant A cannot UPDATE tenant B allowlist rows (rows invisible to USING filter)', async () => {
    const updated = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .update(tenantImageSourceAllowlist)
        .set({ isDefault: true })
        .where(eq(tenantImageSourceAllowlist.tenantId, tenantB.ctx.slug))
        .returning({ id: tenantImageSourceAllowlist.id }),
    );
    expect(updated).toEqual([]);
    // Verify tenant B's row is unchanged via bypass-RLS read
    const bRows = await db
      .select()
      .from(tenantImageSourceAllowlist)
      .where(
        and(
          eq(tenantImageSourceAllowlist.tenantId, tenantB.ctx.slug),
          eq(tenantImageSourceAllowlist.hostname, B_HOST),
        ),
      );
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.isDefault).toBe(false);
  });

  it('DELETE: tenant A cannot DELETE tenant B allowlist rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, async (tx) =>
      tx
        .delete(tenantImageSourceAllowlist)
        .where(eq(tenantImageSourceAllowlist.tenantId, tenantB.ctx.slug))
        .returning({ id: tenantImageSourceAllowlist.id }),
    );
    expect(deleted).toEqual([]);
    // Verify tenant B's row still exists via bypass-RLS read
    const bRows = await db
      .select()
      .from(tenantImageSourceAllowlist)
      .where(eq(tenantImageSourceAllowlist.tenantId, tenantB.ctx.slug));
    expect(bRows).toHaveLength(1);
  });

  // T128 + T128b (F7.1a Phase 6) — un-todo'd 2026-05-21 once the
  // wiring landed in `manage-image-allowlist.ts:147-200` (defensive
  // probe-emit on `port.remove` returning `not_found`). Data-model § 7
  // + Constitution Principle I sub-clause 4 mandate a forensic emit
  // for every cross-tenant probe class — this case captures the
  // remove-from-foreign-tenant vector (admin under tenant B tries to
  // remove a hostname they observed in tenant A via OOB channel).
  //
  // Drives the use-case end-to-end against live Neon under
  // runInTenant(tenantB.ctx) so the storage tx scope mirrors the route
  // handler exactly. RLS+FORCE filters tenant A's row from tenant B's
  // visibility → port.remove returns not_found → use-case emits
  // broadcast_cross_tenant_probe defensively.
  it('AUDIT: tenant B remove probe of tenant A hostname emits broadcast_cross_tenant_probe', async () => {
    const probeRequestId = `t128-probe-${randomUUID()}`;
    const actorUserId = randomUUID();

    const result = await runInTenant(tenantB.ctx, async () =>
      manageImageAllowlist(makeManageImageAllowlistDeps(tenantB.ctx.slug), {
        // tenantB context = actor's session-resolved tenant
        tenantId: tenantB.ctx.slug as never,
        actorUserId,
        action: 'remove',
        // A_HOST exists in tenant A but is invisible to tenant B
        // under RLS — port.remove will return `not_found`.
        hostname: A_HOST,
        requestId: probeRequestId,
      }),
    );

    // Step 1: result is `not_found` (RLS filtered A_HOST from B's view)
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not_found');
    }

    // Step 2: audit row committed — query via schema-owner bypass-RLS.
    // Filter by requestId (unique per probe) + tenantId; eventType
    // asserted in JS to dodge Drizzle's narrow enum-inferred type.
    const probeRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.requestId, probeRequestId),
          eq(auditLog.tenantId, tenantB.ctx.slug),
        ),
      );

    expect(probeRows).toHaveLength(1);
    const row = probeRows[0];
    expect(row?.eventType).toBe('broadcast_cross_tenant_probe');
    expect(row?.actorUserId).toBe(actorUserId);
    expect(row?.payload).toMatchObject({
      surface: 'tenant_image_source_allowlist',
      operation: 'remove',
      probedHostname: A_HOST,
      expectedTenantId: tenantB.ctx.slug,
    });

    // Step 3: tenant A's row is unchanged (defence-in-depth verify)
    const aRows = await db
      .select()
      .from(tenantImageSourceAllowlist)
      .where(
        and(
          eq(tenantImageSourceAllowlist.tenantId, tenantA.ctx.slug),
          eq(tenantImageSourceAllowlist.hostname, A_HOST),
        ),
      );
    expect(aRows).toHaveLength(1);
  });

  it('INSERT: tenant A cannot INSERT a row with tenantId=tenantB (WITH CHECK rejects)', async () => {
    await expect(async () => {
      await runInTenant(tenantA.ctx, async (tx) =>
        tx.insert(tenantImageSourceAllowlist).values({
          tenantId: tenantB.ctx.slug,
          hostname: 'forged-by-a.example.com',
          isDefault: false,
          createdByUserId: null,
        }),
      );
    }).rejects.toThrow();
    // Verify no forged row was created via bypass-RLS read
    const forged = await db
      .select()
      .from(tenantImageSourceAllowlist)
      .where(
        and(
          eq(tenantImageSourceAllowlist.tenantId, tenantB.ctx.slug),
          eq(tenantImageSourceAllowlist.hostname, 'forged-by-a.example.com'),
        ),
      );
    expect(forged).toHaveLength(0);
  });
});
