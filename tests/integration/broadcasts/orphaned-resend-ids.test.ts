/**
 * Spec 140 s2c — migration 0325's `broadcast_orphaned_resend_ids` on real
 * Postgres, run as `chamber_app` inside `runInTenant`.
 *
 *   - the CHECKs: the three closed value sets (pinned against the Domain
 *     tuples), `(resource_id IS NULL) = (reason = 'create_unconfirmed')`,
 *     `create_unconfirmed` ⇒ `broadcast`, a non-blank id, and
 *     `(settled_at IS NULL) = (outcome IS NULL)`;
 *   - the partial UNIQUE on (tenant, resource_type, resource_id) for a known id;
 *   - RLS + FORCE: another tenant reads none of the rows, cannot write into
 *     this tenant, and `chamber_app` holds no DELETE;
 *   - [P M-1] the SECURITY DEFINER prune: settled rows and `create_unconfirmed`
 *     rows older than the cutoff go, an unsettled known id never does, only the
 *     caller's own tenant is touched, and a cutoff younger than
 *     `ORPHAN_ROW_RETENTION_DAYS` is refused.
 *
 * Each CHECK probe runs in a savepoint that is always rolled back, one
 * violation per savepoint (the 0322 shape).
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import {
  ORPHAN_OUTCOMES,
  ORPHAN_REASONS,
  ORPHAN_RESOURCE_TYPES,
  ORPHAN_PRUNE_SKEW_MARGIN_MS,
  ORPHAN_ROW_RETENTION_DAYS,
} from '@/modules/broadcasts/domain/value-objects/orphaned-resend-id';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

type Tx = Parameters<Parameters<typeof runInTenant>[1]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;

class Rollback extends Error {}

/** The SQLSTATE and constraint of the first Postgres error in the cause chain. */
function pgViolation(error: unknown): string | null {
  let cur: unknown = error;
  while (cur !== null && typeof cur === 'object') {
    const { code, constraint_name: constraint } = cur as { code?: unknown; constraint_name?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return `${code} ${typeof constraint === 'string' ? constraint : '(no constraint)'}`;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

interface Row {
  readonly resourceType?: string;
  readonly resourceId?: string | null;
  readonly reason?: string;
  readonly createdAt?: Date;
  readonly settledAt?: Date | null;
  readonly outcome?: string | null;
}

function insertSql(tenantSlug: string, r: Row): ReturnType<typeof sql> {
  return sql`
    INSERT INTO broadcast_orphaned_resend_ids
      (tenant_id, broadcast_id, requested_by_member_id, resource_type, resource_id, reason, created_at, settled_at, outcome)
    VALUES (
      ${tenantSlug}, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
      ${r.resourceType ?? 'broadcast'},
      ${r.resourceId === undefined ? `rb-${randomUUID()}` : r.resourceId},
      ${r.reason ?? 'attach_lost'},
      ${(r.createdAt ?? new Date()).toISOString()}::timestamptz,
      ${r.settledAt === undefined || r.settledAt === null ? null : r.settledAt.toISOString()}::timestamptz,
      ${r.outcome ?? null}
    )`;
}

describe('spec 140 s2c — 0325 broadcast_orphaned_resend_ids', () => {
  let tenant: TestTenant;
  let other: TestTenant;

  /** Run `stmt` as chamber_app in `t`, in a savepoint that is always rolled back. */
  async function attempt(t: TestTenant, stmt: ReturnType<typeof sql>): Promise<string> {
    return runInTenant(t.ctx, async (tx: Tx) => {
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(stmt);
          throw new Rollback();
        });
      } catch (e) {
        if (e instanceof Rollback) return 'ok';
        return pgViolation(e) ?? `other: ${errorChainMessage(e).slice(0, 160)}`;
      }
      return 'unreachable';
    });
  }

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    other = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
    if (other) await other.cleanup();
  });

  it('admits every Domain reason, resource type and outcome, and refuses a value outside each set', async () => {
    for (const reason of ORPHAN_REASONS) {
      const row: Row =
        reason === 'create_unconfirmed' ? { reason, resourceId: null } : { reason };
      expect(await attempt(tenant, insertSql(tenant.ctx.slug, row)), reason).toBe('ok');
    }
    for (const resourceType of ORPHAN_RESOURCE_TYPES) {
      expect(await attempt(tenant, insertSql(tenant.ctx.slug, { resourceType })), resourceType).toBe('ok');
    }
    for (const outcome of ORPHAN_OUTCOMES) {
      expect(await attempt(tenant, insertSql(tenant.ctx.slug, { settledAt: new Date(), outcome })), outcome).toBe('ok');
    }
    expect(await attempt(tenant, insertSql(tenant.ctx.slug, { reason: 'made_up' }))).toBe(
      '23514 broadcast_orphaned_resend_ids_reason_check',
    );
    expect(await attempt(tenant, insertSql(tenant.ctx.slug, { resourceType: 'import' }))).toBe(
      '23514 broadcast_orphaned_resend_ids_resource_type_check',
    );
    expect(await attempt(tenant, insertSql(tenant.ctx.slug, { settledAt: new Date(), outcome: 'kept' }))).toBe(
      '23514 broadcast_orphaned_resend_ids_outcome_check',
    );
  });

  it('a NULL id iff create_unconfirmed; create_unconfirmed is a broadcast; an id is never blank; settled_at and outcome come together', async () => {
    const slug = tenant.ctx.slug;
    expect(await attempt(tenant, insertSql(slug, { reason: 'attach_lost', resourceId: null }))).toBe(
      '23514 broadcast_orphaned_resend_ids_id_iff_known',
    );
    expect(await attempt(tenant, insertSql(slug, { reason: 'create_unconfirmed', resourceId: 'rb-1' }))).toBe(
      '23514 broadcast_orphaned_resend_ids_id_iff_known',
    );
    expect(
      await attempt(tenant, insertSql(slug, { reason: 'create_unconfirmed', resourceId: null, resourceType: 'audience' })),
    ).toBe('23514 broadcast_orphaned_resend_ids_unconfirmed_is_broadcast');
    expect(await attempt(tenant, insertSql(slug, { resourceId: '   ' }))).toBe(
      '23514 broadcast_orphaned_resend_ids_resource_id_nonblank',
    );
    expect(await attempt(tenant, insertSql(slug, { settledAt: new Date(), outcome: null }))).toBe(
      '23514 broadcast_orphaned_resend_ids_settled_pair',
    );
    expect(await attempt(tenant, insertSql(slug, { settledAt: null, outcome: 'deleted' }))).toBe(
      '23514 broadcast_orphaned_resend_ids_settled_pair',
    );
  });

  it('a known id is unique per (tenant, resource type); NULL ids and other tenants do not collide', async () => {
    const id = `rb-${randomUUID()}`;
    await runInTenant(tenant.ctx, (tx: Tx) => tx.execute(insertSql(tenant.ctx.slug, { resourceId: id })));
    expect(await attempt(tenant, insertSql(tenant.ctx.slug, { resourceId: id, reason: 'row_vanished' }))).toBe(
      '23505 broadcast_orphaned_resend_ids_resource_uq',
    );
    expect(await attempt(tenant, insertSql(tenant.ctx.slug, { resourceId: id, resourceType: 'audience' }))).toBe('ok');
    expect(await attempt(other, insertSql(other.ctx.slug, { resourceId: id }))).toBe('ok');
    await runInTenant(tenant.ctx, async (tx: Tx) => {
      await tx.execute(insertSql(tenant.ctx.slug, { reason: 'create_unconfirmed', resourceId: null }));
      await tx.execute(insertSql(tenant.ctx.slug, { reason: 'create_unconfirmed', resourceId: null }));
    });
  });

  it('RLS + FORCE: another tenant reads none, cannot insert into or update this tenant, and chamber_app has no DELETE', async () => {
    const id = `rb-${randomUUID()}`;
    await runInTenant(tenant.ctx, (tx: Tx) => tx.execute(insertSql(tenant.ctx.slug, { resourceId: id })));
    const seenByOther = (await runInTenant(other.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT orphan_id FROM broadcast_orphaned_resend_ids WHERE resource_id = ${id}`),
    )) as unknown as unknown[];
    expect(seenByOther).toHaveLength(0);
    const seenByOwner = (await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT orphan_id FROM broadcast_orphaned_resend_ids WHERE resource_id = ${id}`),
    )) as unknown as unknown[];
    expect(seenByOwner).toHaveLength(1);

    expect(await attempt(other, insertSql(tenant.ctx.slug, {}))).toBe('42501 (no constraint)');
    const updated = (await runInTenant(other.ctx, (tx: Tx) =>
      tx.execute(sql`
        UPDATE broadcast_orphaned_resend_ids SET settled_at = now(), outcome = 'deleted'
         WHERE resource_id = ${id} RETURNING orphan_id`),
    )) as unknown as unknown[];
    expect(updated).toHaveLength(0);
    expect(
      await attempt(tenant, sql`DELETE FROM broadcast_orphaned_resend_ids WHERE resource_id = ${id}`),
    ).toBe('42501 (no constraint)');
  });

  it('[P M-1] the prune deletes settled and create_unconfirmed rows past the cutoff, only in the caller tenant, and refuses a young cutoff', async () => {
    const now = Date.now();
    const old = new Date(now - (ORPHAN_ROW_RETENTION_DAYS + 1) * DAY_MS);
    const young = new Date(now - (ORPHAN_ROW_RETENTION_DAYS - 1) * DAY_MS);
    const ids = {
      settledOld: `rb-${randomUUID()}`,
      settledYoung: `rb-${randomUUID()}`,
      unsettledOld: `rb-${randomUUID()}`,
      otherSettledOld: `rb-${randomUUID()}`,
    };
    const unconfirmedOld = randomUUID();
    const unconfirmedYoung = randomUUID();
    await runInTenant(tenant.ctx, async (tx: Tx) => {
      const slug = tenant.ctx.slug;
      await tx.execute(insertSql(slug, { resourceId: ids.settledOld, createdAt: old, settledAt: old, outcome: 'deleted' }));
      await tx.execute(insertSql(slug, { resourceId: ids.settledYoung, createdAt: old, settledAt: young, outcome: 'absent' }));
      await tx.execute(insertSql(slug, { resourceId: ids.unsettledOld, createdAt: new Date(now - 400 * DAY_MS) }));
      await tx.execute(sql`
        INSERT INTO broadcast_orphaned_resend_ids (tenant_id, broadcast_id, requested_by_member_id, resource_type, resource_id, reason, created_at)
        VALUES (${slug}, ${unconfirmedOld}::uuid, ${randomUUID()}::uuid, 'broadcast', NULL, 'create_unconfirmed', ${old.toISOString()}::timestamptz),
               (${slug}, ${unconfirmedYoung}::uuid, ${randomUUID()}::uuid, 'broadcast', NULL, 'create_unconfirmed', ${young.toISOString()}::timestamptz)`);
    });
    await runInTenant(other.ctx, (tx: Tx) =>
      tx.execute(insertSql(other.ctx.slug, { resourceId: ids.otherSettledOld, createdAt: old, settledAt: old, outcome: 'deleted' })),
    );

    // The sweep's cutoff: a margin older than the floor, so this workstation's
    // clock running ahead of Neon's cannot make it "too recent".
    const cutoff = new Date(now - ORPHAN_ROW_RETENTION_DAYS * DAY_MS - ORPHAN_PRUNE_SKEW_MARGIN_MS);
    // Another tenant's slug is refused: the function runs as the owner, so it fences itself.
    expect(
      await attempt(tenant, sql`SELECT prune_orphaned_resend_ids(${other.ctx.slug}, ${cutoff.toISOString()}::timestamptz)`),
    ).toBe('42501 (no constraint)');
    // A cutoff younger than the retention would shorten it: refused.
    expect(
      await attempt(tenant, sql`SELECT prune_orphaned_resend_ids(${tenant.ctx.slug}, ${young.toISOString()}::timestamptz)`),
    ).toBe('22023 (no constraint)');

    const pruned = (await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT prune_orphaned_resend_ids(${tenant.ctx.slug}, ${cutoff.toISOString()}::timestamptz) AS n`),
    )) as unknown as Array<{ n: number }>;
    expect(Number(pruned[0]?.n)).toBe(2);

    const left = (await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT resource_id, broadcast_id::text AS broadcast_id FROM broadcast_orphaned_resend_ids`),
    )) as unknown as Array<{ resource_id: string | null; broadcast_id: string }>;
    const leftIds = new Set(left.map((r) => r.resource_id ?? r.broadcast_id));
    expect(leftIds.has(ids.settledOld)).toBe(false);
    expect(leftIds.has(unconfirmedOld)).toBe(false);
    expect(leftIds.has(ids.settledYoung)).toBe(true);
    expect(leftIds.has(ids.unsettledOld)).toBe(true);
    expect(leftIds.has(unconfirmedYoung)).toBe(true);

    const otherLeft = (await runInTenant(other.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT orphan_id FROM broadcast_orphaned_resend_ids WHERE resource_id = ${ids.otherSettledOld}`),
    )) as unknown as unknown[];
    expect(otherLeft).toHaveLength(1);
  });

  /**
   * Spec 140 s2c review round 1 — the hardening of 0325:
   *   - [pdpa M-A] the prune keeps a `handed` row (the durable disclosure record);
   *   - [migration M2] `chamber_app` may UPDATE only the settle and attempt
   *     columns (`settled_at`, `outcome`, `attempts`, `last_attempted_at`);
   *   - [migration M1] the SECURITY DEFINER prune resolves the real table even
   *     when the caller has a `pg_temp` shadow of the same name.
   */
  it('[pdpa M-A] the prune keeps an old handed row and deletes an old deleted one', async () => {
    const old = new Date(Date.now() - (ORPHAN_ROW_RETENTION_DAYS + 1) * DAY_MS);
    const handed = `rb-handed-${randomUUID()}`;
    const gone = `rb-gone-${randomUUID()}`;
    await runInTenant(tenant.ctx, async (tx: Tx) => {
      await tx.execute(insertSql(tenant.ctx.slug, { resourceId: handed, createdAt: old, settledAt: old, outcome: 'handed' }));
      await tx.execute(insertSql(tenant.ctx.slug, { resourceId: gone, createdAt: old, settledAt: old, outcome: 'deleted' }));
    });
    const cutoff = new Date(Date.now() - ORPHAN_ROW_RETENTION_DAYS * DAY_MS - ORPHAN_PRUNE_SKEW_MARGIN_MS);
    await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT prune_orphaned_resend_ids(${tenant.ctx.slug}, ${cutoff.toISOString()}::timestamptz)`),
    );
    const left = (await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT resource_id FROM broadcast_orphaned_resend_ids WHERE resource_id IN (${handed}, ${gone})`),
    )) as unknown as Array<{ resource_id: string }>;
    expect(left.map((r) => r.resource_id)).toEqual([handed]);
  });

  it('[migration M2] chamber_app may update only settled_at, outcome, attempts and last_attempted_at', async () => {
    const id = `rb-grant-${randomUUID()}`;
    await runInTenant(tenant.ctx, (tx: Tx) => tx.execute(insertSql(tenant.ctx.slug, { resourceId: id })));
    const where = sql`WHERE tenant_id = ${tenant.ctx.slug} AND resource_id = ${id}`;
    expect(await attempt(tenant, sql`UPDATE broadcast_orphaned_resend_ids SET attempts = attempts + 1, last_attempted_at = now() ${where}`)).toBe('ok');
    expect(await attempt(tenant, sql`UPDATE broadcast_orphaned_resend_ids SET settled_at = now(), outcome = 'deleted' ${where}`)).toBe('ok');
    expect(await attempt(tenant, sql`UPDATE broadcast_orphaned_resend_ids SET reason = 'row_vanished' ${where}`)).toBe('42501 (no constraint)');
    expect(await attempt(tenant, sql`UPDATE broadcast_orphaned_resend_ids SET created_at = now() ${where}`)).toBe('42501 (no constraint)');
    expect(await attempt(tenant, sql`UPDATE broadcast_orphaned_resend_ids SET resource_id = 'other' ${where}`)).toBe('42501 (no constraint)');
  });

  it('[migration M1] the prune ignores a pg_temp table shadowing broadcast_orphaned_resend_ids', async () => {
    const old = new Date(Date.now() - (ORPHAN_ROW_RETENTION_DAYS + 1) * DAY_MS);
    const real = `rb-real-${randomUUID()}`;
    await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(insertSql(tenant.ctx.slug, { resourceId: real, createdAt: old, settledAt: old, outcome: 'absent' })),
    );
    const cutoff = new Date(Date.now() - ORPHAN_ROW_RETENTION_DAYS * DAY_MS - ORPHAN_PRUNE_SKEW_MARGIN_MS);
    const pruned = (await runInTenant(tenant.ctx, async (tx: Tx) => {
      // A shadow in the caller's session: with pg_temp first on the path, the
      // owner-run function would delete from it, and the real row would stay.
      await tx.execute(sql`CREATE TEMP TABLE broadcast_orphaned_resend_ids (LIKE public.broadcast_orphaned_resend_ids) ON COMMIT DROP`);
      return tx.execute(sql`SELECT prune_orphaned_resend_ids(${tenant.ctx.slug}, ${cutoff.toISOString()}::timestamptz) AS n`);
    })) as unknown as Array<{ n: number }>;
    expect(Number(pruned[0]?.n)).toBeGreaterThanOrEqual(1);
    const left = (await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT 1 FROM broadcast_orphaned_resend_ids WHERE resource_id = ${real}`),
    )) as unknown as unknown[];
    expect(left).toHaveLength(0);
  });

  it('the attempt columns exist with their defaults (attempts 0, last_attempted_at NULL)', async () => {
    const id = `rb-cols-${randomUUID()}`;
    await runInTenant(tenant.ctx, (tx: Tx) => tx.execute(insertSql(tenant.ctx.slug, { resourceId: id })));
    const rows = (await runInTenant(tenant.ctx, (tx: Tx) =>
      tx.execute(sql`SELECT attempts, last_attempted_at FROM broadcast_orphaned_resend_ids WHERE resource_id = ${id}`),
    )) as unknown as Array<{ attempts: number; last_attempted_at: string | null }>;
    expect(rows).toEqual([{ attempts: 0, last_attempted_at: null }]);
  });
});
