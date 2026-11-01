/**
 * Spec 140 s2b — migration 0322's lease columns on real Postgres.
 *
 *   broadcasts_dispatch_lease_pair   (dispatch_lease_token IS NULL)
 *                                    = (dispatch_lease_expires_at IS NULL)
 *
 * A token with no expiry would be a lease that never ends; an expiry with no
 * token a lease nobody holds. Both are refused, both-set and both-NULL are
 * admitted. Each probe runs as `chamber_app` inside `runInTenant` (RLS passes,
 * so the CHECK is what answers) in a savepoint that is always rolled back, one
 * violation per savepoint (a refused statement poisons only its savepoint).
 */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

type Tx = Parameters<Parameters<typeof runInTenant>[1]>[0];

const SEED_AT = new Date('2026-10-01T03:00:00Z');

class Rollback extends Error {}

/** The SQLSTATE and constraint of the first Postgres error in the cause chain. */
function checkViolation(error: unknown): string | null {
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

describe('spec 140 s2b — 0322 dispatch lease columns', () => {
  let tenant: TestTenant;
  const broadcastId = randomUUID();

  async function attempt(set: ReturnType<typeof sql>): Promise<string> {
    return runInTenant(tenant.ctx, async (tx: Tx) => {
      try {
        await tx.transaction(async (sp) => {
          const rows = (await sp.execute(sql`
            UPDATE broadcasts SET ${set}
             WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}::uuid
            RETURNING broadcast_id
          `)) as unknown as unknown[];
          if (rows.length !== 1) throw new Error(`probe matched ${rows.length} rows`);
          throw new Rollback();
        });
      } catch (e) {
        if (e instanceof Rollback) return 'ok';
        return checkViolation(e) ?? `other: ${errorChainMessage(e).slice(0, 160)}`;
      }
      return 'unreachable';
    });
  }

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-140-s2b',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: '140 s2b lease',
        bodyHtml: '<p>x</p>',
        bodySource: 'x',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'approved',
        submittedAt: SEED_AT,
        approvedAt: SEED_AT,
        scheduledFor: SEED_AT,
      }),
    );
  });

  afterAll(async () => {
    if (tenant) await tenant.cleanup();
  });

  it('broadcasts_dispatch_lease_pair: both or neither (token without expiry and expiry without token are refused)', async () => {
    expect(await attempt(sql`dispatch_lease_token = gen_random_uuid(), dispatch_lease_expires_at = now()`)).toBe('ok');
    expect(await attempt(sql`dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL`)).toBe('ok');
    expect(await attempt(sql`dispatch_lease_token = gen_random_uuid()`)).toBe('23514 broadcasts_dispatch_lease_pair');
    expect(await attempt(sql`dispatch_lease_expires_at = now()`)).toBe('23514 broadcasts_dispatch_lease_pair');
  });
});
