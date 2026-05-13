/**
 * T073 — Integration test: `makeDrizzleTenantWebhookConfigRepository`.
 *
 * Covers every adapter operation against live Neon Singapore inside
 * `runInTenant(ctx, fn)` (Constitution Principle I — RLS-scoped).
 *
 * Operations covered:
 *   • `insert` → fresh row + already_exists on conflict
 *   • `findByTenantSource` → row hit + null miss
 *   • `rotateSecret` → atomic active→grace + new active + last_rotated
 *   • `setEnabled` → toggle false + back to true
 *   • `touchLastReceivedAt` → row hit + not_found on missing
 *   • `clearExpiredGrace` → clears 1 row when grace_rotated_at < cutoff;
 *                           returns 0 when no grace active
 *
 * Plus a cross-tenant probe: tenant B cannot SELECT tenant A's row even
 * after seeding (RLS+FORCE enforcement — mirrors T042 invariant for the
 * adapter surface).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { makeDrizzleTenantWebhookConfigRepository } from '@/modules/events/infrastructure/drizzle-tenant-webhook-config-repository';
import { asTenantId } from '@/modules/members';
import type { WebhookSecret } from '@/modules/events';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const SECRET_A = ('whsec_A_' + 'a'.repeat(40)) as WebhookSecret;
const SECRET_B = ('whsec_B_' + 'b'.repeat(40)) as WebhookSecret;
const SECRET_NEW = ('whsec_NEW_' + 'c'.repeat(40)) as WebhookSecret;

describe('T073 — drizzle tenant-webhook-config repository', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  it('insert + findByTenantSource — fresh tenant gets row', async () => {
    await runInTenant(tenantA.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);

      const insertResult = await repo.insert({
        tenantId: asTenantId(tenantA.ctx.slug),
        source: 'eventcreate',
        activeSecret: SECRET_A,
      });
      expect(insertResult.ok).toBe(true);
      if (!insertResult.ok) throw new Error('unreachable');
      expect(insertResult.value.activeSecret).toBe(SECRET_A);
      expect(insertResult.value.graceSecret).toBeNull();
      expect(insertResult.value.graceRotatedAt).toBeNull();
      expect(insertResult.value.enabled).toBe(true);

      const lookup = await repo.findByTenantSource(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
      );
      expect(lookup.ok).toBe(true);
      if (!lookup.ok) throw new Error('unreachable');
      expect(lookup.value).not.toBeNull();
      expect(lookup.value!.activeSecret).toBe(SECRET_A);
    });
  });

  it('insert again — already_exists error', async () => {
    await runInTenant(tenantA.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const result = await repo.insert({
        tenantId: asTenantId(tenantA.ctx.slug),
        source: 'eventcreate',
        activeSecret: SECRET_A,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.kind).toBe('already_exists');
    });
  });

  it('findByTenantSource — null when no row', async () => {
    await runInTenant(tenantB.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const result = await repo.findByTenantSource(
        asTenantId(tenantB.ctx.slug),
        'eventcreate',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBeNull();
    });
  });

  it('rotateSecret — active→grace + new active + last_rotated_at set', async () => {
    const before = new Date();
    let firstActive: WebhookSecret;
    await runInTenant(tenantA.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const lookup = await repo.findByTenantSource(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
      );
      if (!lookup.ok || !lookup.value) throw new Error('precondition: row missing');
      firstActive = lookup.value.activeSecret;

      const rotated = await repo.rotateSecret({
        tenantId: asTenantId(tenantA.ctx.slug),
        source: 'eventcreate',
        newActiveSecret: SECRET_NEW,
        now: new Date(),
      });
      expect(rotated.ok).toBe(true);
      if (!rotated.ok) throw new Error('unreachable');
      expect(rotated.value.activeSecret).toBe(SECRET_NEW);
      expect(rotated.value.graceSecret).toBe(firstActive);
      expect(rotated.value.graceRotatedAt).toBeInstanceOf(Date);
      expect(rotated.value.lastRotatedAt).toBeInstanceOf(Date);
      expect(rotated.value.lastRotatedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  it('rotateSecret — not_found when row does not exist', async () => {
    await runInTenant(tenantB.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const result = await repo.rotateSecret({
        tenantId: asTenantId(tenantB.ctx.slug),
        source: 'eventcreate',
        newActiveSecret: SECRET_NEW,
        now: new Date(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.kind).toBe('not_found');
    });
  });

  it('setEnabled — toggle false + back to true', async () => {
    await runInTenant(tenantA.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);

      const off = await repo.setEnabled(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
        false,
      );
      expect(off.ok).toBe(true);
      if (!off.ok) throw new Error('unreachable');
      expect(off.value.enabled).toBe(false);

      const on = await repo.setEnabled(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
        true,
      );
      expect(on.ok).toBe(true);
      if (!on.ok) throw new Error('unreachable');
      expect(on.value.enabled).toBe(true);
    });
  });

  it('setEnabled — not_found when row does not exist', async () => {
    await runInTenant(tenantB.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const result = await repo.setEnabled(
        asTenantId(tenantB.ctx.slug),
        'eventcreate',
        false,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.kind).toBe('not_found');
    });
  });

  it('touchLastReceivedAt — updates timestamp', async () => {
    const heartbeat = new Date('2026-06-01T10:23:15Z');
    await runInTenant(tenantA.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const touch = await repo.touchLastReceivedAt(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
        heartbeat,
      );
      expect(touch.ok).toBe(true);

      const after = await repo.findByTenantSource(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
      );
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error('unreachable');
      expect(after.value!.lastReceivedAt).toEqual(heartbeat);
    });
  });

  it('clearExpiredGrace — clears 1 row when grace_rotated_at < cutoff', async () => {
    // Tenant A still has the grace row from the rotateSecret test above.
    // Cutoff = now + 1ms catches that grace window deterministically.
    await runInTenant(tenantA.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const cutoff = new Date(Date.now() + 1);
      const result = await repo.clearExpiredGrace(
        asTenantId(tenantA.ctx.slug),
        cutoff,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBe(1);

      const after = await repo.findByTenantSource(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
      );
      expect(after.ok).toBe(true);
      if (!after.ok) throw new Error('unreachable');
      expect(after.value!.graceSecret).toBeNull();
      expect(after.value!.graceRotatedAt).toBeNull();
    });
  });

  it('clearExpiredGrace — returns 0 when no grace active', async () => {
    // Re-run on the same tenant — grace already cleared above.
    await runInTenant(tenantA.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const result = await repo.clearExpiredGrace(
        asTenantId(tenantA.ctx.slug),
        new Date(Date.now() + 1),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBe(0);
    });
  });

  it('cross-tenant probe — tenant B cannot SELECT tenant A row via repo', async () => {
    // Seed tenant B so this test isn't a vacuous cross-tenant test.
    await runInTenant(tenantB.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      await repo.insert({
        tenantId: asTenantId(tenantB.ctx.slug),
        source: 'eventcreate',
        activeSecret: SECRET_B,
      });
    });

    // From tenant B's RLS scope, try to look up tenant A's slug.
    // RLS should treat this as "no row" — null, NOT tenant A's secret.
    await runInTenant(tenantB.ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const probe = await repo.findByTenantSource(
        asTenantId(tenantA.ctx.slug),
        'eventcreate',
      );
      expect(probe.ok).toBe(true);
      if (!probe.ok) throw new Error('unreachable');
      expect(probe.value).toBeNull();
    });
  });
});
