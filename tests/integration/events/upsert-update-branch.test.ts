/**
 * Integration test for the `(xmax = 0)` upsert discriminator UPDATE
 * branch (gap-3 from /speckit-review).
 *
 * The TOCTOU fix in `drizzle-events-repository.ts` swapped a two-step
 * INSERT+SELECT for a single-statement `INSERT ... ON CONFLICT DO
 * UPDATE ... RETURNING *, (xmax = 0)`. The S3 idempotency test
 * verifies that `eventCreated=false` returns on conflict, but does
 * NOT verify the UPDATE actually applied the new field values
 * (FR-010 last-write-wins).
 *
 * This test asserts:
 *   1. First call → `eventCreated=true` + row reflects first payload
 *   2. Second call with same (tenant, source, externalId) but a NEW
 *      `name` → `eventCreated=false` + row reflects the NEW name
 *      (FR-010 confirmed)
 *
 * Regression caught: a future Drizzle bump that changes `xmax`
 * aliasing OR a refactor that loses the `.set(...)` clause would
 * fail this test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
  events,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { makeDrizzleEventsRepository } from '@/modules/events/infrastructure/drizzle-events-repository';
import { asExternalEventId } from '@/modules/events';
import type { TenantId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('events upsert (xmax = 0) UPDATE branch — gap-3', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-chamber');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
        enabled: true,
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('first call returns eventCreated=true and persists initial values', async () => {
    const externalId = asExternalEventId(`evt-fresh-${Date.now()}`);

    const result = await runInTenant(tenant.ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.upsert({
        tenantId: tenant.ctx.slug as unknown as TenantId,
        source: 'eventcreate',
        externalId,
        name: 'Initial name',
        description: 'first',
        startDate: new Date('2026-06-01T10:00:00Z'),
        endDate: null,
        location: 'BKK',
        category: null,
        eventcreateUrl: null,
        metadata: {},
      });
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('first upsert must succeed');
    expect(result.value.eventCreated).toBe(true);
    expect(result.value.event.name).toBe('Initial name');
  });

  it('second call with same key + different name returns eventCreated=false AND row reflects new name (FR-010)', async () => {
    const externalId = asExternalEventId(`evt-update-${Date.now()}`);

    // 1. Seed the row
    await runInTenant(tenant.ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      const r = await repo.upsert({
        tenantId: tenant.ctx.slug as unknown as TenantId,
        source: 'eventcreate',
        externalId,
        name: 'Original',
        description: null,
        startDate: new Date('2026-07-01T10:00:00Z'),
        endDate: null,
        location: null,
        category: null,
        eventcreateUrl: null,
        metadata: {},
      });
      if (!r.ok) throw new Error('seed upsert failed');
      expect(r.value.eventCreated).toBe(true);
    });

    // 2. Update via second upsert (conflict on (tenant, source, externalId))
    const secondResult = await runInTenant(tenant.ctx, async (tx) => {
      const repo = makeDrizzleEventsRepository(tx);
      return repo.upsert({
        tenantId: tenant.ctx.slug as unknown as TenantId,
        source: 'eventcreate',
        externalId,
        name: 'Updated last-write-wins',
        description: 'now with description',
        startDate: new Date('2026-08-15T14:30:00Z'),
        endDate: new Date('2026-08-15T17:00:00Z'),
        location: 'Updated location',
        category: 'updated-category',
        eventcreateUrl: 'https://eventcreate.test/x',
        metadata: { newField: 'present' },
      });
    });

    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) throw new Error('second upsert must succeed');

    // xmax != 0 ⇔ UPDATE path taken
    expect(secondResult.value.eventCreated).toBe(false);
    // FR-010 last-write-wins — every field reflects the second payload
    expect(secondResult.value.event.name).toBe('Updated last-write-wins');
    expect(secondResult.value.event.description).toBe('now with description');
    expect(secondResult.value.event.location).toBe('Updated location');
    expect(secondResult.value.event.category).toBe('updated-category');
    expect(secondResult.value.event.eventcreateUrl).toBe('https://eventcreate.test/x');

    // Confirm DB read independently — UPDATE branch values landed
    const rowsAfter = await runInTenant(tenant.ctx, async (tx) =>
      tx.select().from(events).where(eq(events.externalId, externalId)),
    );
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]!.name).toBe('Updated last-write-wins');
  });
});
