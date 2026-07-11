/**
 * Bug #14 (2026-07-10) — a broadcast-template name freed by soft-delete must
 * be re-creatable. Before the fix, the (tenant, name, locale) unique index
 * covered soft-deleted rows too, so create() 409'd forever for a name that
 * appeared in no list surface. Migration 0239 makes the index PARTIAL
 * (WHERE deleted_at IS NULL); create()'s ON CONFLICT arbiter carries the same
 * predicate. Live DB only — the fix IS the DB index behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '@/lib/db';
import { broadcastTemplates } from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleBroadcastTemplatesRepo } from '@/modules/broadcasts/infrastructure/drizzle-broadcast-templates-repo';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('broadcast template name reuse after soft-delete — bug #14', () => {
  let tenant: TestTenant;
  const repo = makeDrizzleBroadcastTemplatesRepo();

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    if (tenant) {
      // test-tenant cleanup does not cover broadcast_templates.
      await db
        .delete(broadcastTemplates)
        .where(eq(broadcastTemplates.tenantId, tenant.ctx.slug));
      await tenant.cleanup();
    }
  });

  it('a name freed by soft-delete can be re-created; a LIVE duplicate is still rejected', async () => {
    const name = `p14-${randomUUID().slice(0, 8)}`;
    const mk = (subject: string) => ({
      name,
      subject,
      bodyHtml: '<p>b</p>',
      locale: 'en' as const,
      createdByUserId: randomUUID(),
    });

    // 1) Create + soft-delete the original.
    const first = await repo.create(tenant.ctx.slug, mk('v1'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const del = await repo.softDelete(tenant.ctx.slug, first.value.id);
    expect(del.ok).toBe(true);

    // 2) Re-create the SAME name+locale — previously 409'd forever; now OK.
    const second = await repo.create(tenant.ctx.slug, mk('v2'));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.id).not.toBe(first.value.id);

    // 3) A LIVE duplicate of the same name+locale is STILL rejected.
    const dup = await repo.create(tenant.ctx.slug, mk('v3'));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.kind).toBe('duplicate_name');
  });
});
