/**
 * F119 T024 follow-up — `setBrandSettings` is SERIALISED per tenant (no lost
 * update), against live Postgres.
 *
 * The use case reads the stored brand, merges the one field the caller
 * changed, and writes BOTH columns back. With a plain read, two admins saving
 * different fields at once each read the same "previous", and the second
 * write silently reverts the first — and its audit row's `previous` names a
 * state that no longer existed. The row is created LAZILY, so a
 * `SELECT … FOR UPDATE` alone would lock nothing on a tenant's first save:
 * the read has to create-then-lock (`findForUpdate`).
 *
 * The latch sits in `save`, AFTER the read: the first call parks there with
 * its read done. The second call is then started. Unserialised, it reads the
 * same empty "previous", writes, and finishes while the first is still
 * parked; serialised, it cannot get past its own read until the first
 * commits. No row is seeded — the lazy first insert is the case under test.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { drizzleBrandSettingsRepo, f7AuditAdapter } from '@/modules/broadcasts';
import type { BrandSettingsRepo } from '@/modules/broadcasts/application/ports/brand-settings-repo';
import { setBrandSettings } from '@/modules/broadcasts/application/use-cases/set-brand-settings';
import { tenantBroadcastSettings } from '@/modules/broadcasts/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('setBrandSettings — concurrent saves of different fields are serialised', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    vi.useRealTimers();
    tenant = await createTestTenant();
  });

  afterAll(async () => {
    await db.delete(tenantBroadcastSettings).where(eq(tenantBroadcastSettings.tenantId, tenant.ctx.slug));
    await tenant.cleanup();
  });

  it('colour-only and address-only saves both land, and audit #2 `previous` is audit #1 `next`', async () => {
    let signalParked!: () => void;
    const parked = new Promise<void>((r) => {
      signalParked = r;
    });
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    // Hang guard: the dev branch runs with statement_timeout = 0, so a lock
    // mistake would otherwise wait forever.
    const fallback = setTimeout(() => release(), 20_000);

    let saveCalls = 0;
    const repo: BrandSettingsRepo = {
      ...drizzleBrandSettingsRepo,
      async save(tenantId, input, tx) {
        saveCalls += 1;
        if (saveCalls === 1) {
          signalParked();
          await released;
        }
        return drizzleBrandSettingsRepo.save(tenantId, input, tx);
      },
    };
    const deps = { repo, audit: f7AuditAdapter };
    const base = { tenantId: tenant.ctx.slug as never, actorRole: 'admin', requestId: randomUUID() };

    const first = setBrandSettings(deps, {
      ...base,
      actorUserId: randomUUID(),
      primaryColor: '#b04a00',
      postalAddress: undefined,
    });
    await parked;

    let secondSettled = false;
    const second = setBrandSettings(deps, {
      ...base,
      actorUserId: randomUUID(),
      primaryColor: undefined,
      postalAddress: '349 Sukhumvit Road',
    }).finally(() => {
      secondSettled = true;
    });

    // Ample for an unblocked save's handful of round-trips to Singapore.
    await Promise.race([second, sleep(3_000)]);
    const secondFinishedWhileFirstHeld = secondSettled;
    release();
    const [a, b] = await Promise.all([first, second]);
    clearTimeout(fallback);

    expect(a.ok && b.ok).toBe(true);

    // 1. No lost update: both fields survive.
    const [row] = await db
      .select({
        color: tenantBroadcastSettings.brandPrimaryColor,
        address: tenantBroadcastSettings.brandPostalAddress,
      })
      .from(tenantBroadcastSettings)
      .where(eq(tenantBroadcastSettings.tenantId, tenant.ctx.slug));
    expect(row).toEqual({ color: '#b04a00', address: '349 Sukhumvit Road' });

    // 2. Serialised: the second save could not finish while the first held its lock.
    expect(secondFinishedWhileFirstHeld).toBe(false);

    // 3. The audit trail is a chain: #2's `previous` is exactly #1's `next`.
    const audits = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'broadcast_brand_settings_changed' as never),
        ),
      );
    expect(audits).toHaveLength(2);
    type Snapshot = { primaryColor: string | null; postalAddress: string | null };
    const payloads = audits.map((r) => r.payload as { previous: Snapshot; next: Snapshot });
    const firstAudit = payloads.find((p) => p.previous.primaryColor === null && p.previous.postalAddress === null);
    const secondAudit = payloads.find((p) => p !== firstAudit);
    expect(firstAudit?.next).toEqual({ primaryColor: '#b04a00', postalAddress: null });
    expect(secondAudit?.previous).toEqual(firstAudit?.next);
    expect(secondAudit?.next).toEqual({ primaryColor: '#b04a00', postalAddress: '349 Sukhumvit Road' });
  }, 60_000);
});
