/**
 * PR-2 Task 2 — integration test: `audience_deleted_at` column +
 * terminal-audience cleanup query + mark on live Neon.
 *
 * Verifies:
 *   1. `listTerminalBroadcastsWithLiveAudience` returns ONLY terminal
 *      broadcasts (failed_to_dispatch) whose `resend_audience_id IS NOT
 *      NULL` AND `audience_deleted_at IS NULL` AND `updated_at < graceCutoff`.
 *      A non-terminal (approved) broadcast with a resend_audience_id is
 *      NOT returned (invariant: an audience may only be deleted for a
 *      terminal broadcast).
 *   2. `markAudienceDeletedInTx` stamps `audience_deleted_at = now()`,
 *      making the row invisible to a subsequent list call (idempotency).
 *   3. Tenant isolation — tenant B's broadcasts are unaffected by
 *      operations on tenant A.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a broadcast row with the supplied overrides. */
async function seedBroadcast(
  tenant: TestTenant,
  opts: {
    broadcastId: string;
    status: string;
    resendAudienceId: string | null;
    audienceDeletedAt: string | null; // ISO string or null
    updatedAtOffset: number; // seconds ago (negative = in past)
  },
): Promise<void> {
  const updatedAt = new Date(Date.now() + opts.updatedAtOffset * 1000);

  // The broadcasts_quota_year_only_on_sent CHECK requires quota_year_consumed +
  // quota_consumed_at to be NON-NULL iff status is 'sent' or
  // 'partial_delivery_accepted'. Provide them for those statuses only.
  const isQuotaConsumedStatus =
    opts.status === 'sent' || opts.status === 'partial_delivery_accepted';
  const quotaYear = isQuotaConsumedStatus ? new Date().getFullYear() : null;
  const quotaConsumedAt = isQuotaConsumedStatus
    ? updatedAt.toISOString()
    : null;

  await runInTenant(tenant.ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count, status,
        retention_years, quota_year_consumed, quota_consumed_at,
        resend_audience_id, audience_deleted_at,
        created_at, updated_at
      ) VALUES (
        ${tenant.ctx.slug},
        ${opts.broadcastId}::uuid,
        ${randomUUID()}::uuid,
        ${'plan-test'},
        ${randomUUID()}::uuid,
        ${'member_self_service'},
        ${'Test subject'},
        ${'<p>Body</p>'},
        ${'plain'},
        ${'Test Member via Test Chamber'},
        ${'reply@example.com'},
        ${'all_members'},
        NULL,
        NULL,
        ${0},
        ${opts.status}::broadcast_status,
        ${5},
        ${quotaYear},
        ${quotaConsumedAt ? sql`${quotaConsumedAt}::timestamptz` : sql`NULL`},
        ${opts.resendAudienceId},
        ${opts.audienceDeletedAt ? sql`${opts.audienceDeletedAt}::timestamptz` : sql`NULL`},
        ${updatedAt.toISOString()}::timestamptz,
        ${updatedAt.toISOString()}::timestamptz
      )
    `),
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PR-2 Task 2 — audience-cleanup repo methods (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  // IDs for tenant A seeds
  const terminalId = randomUUID();   // failed_to_dispatch + audience, 2h ago
  const nonTerminalId = randomUUID(); // approved + audience — must NOT appear
  const noAudienceId = randomUUID();  // failed_to_dispatch, no audience — must NOT appear
  const alreadyDeletedId = randomUUID(); // failed_to_dispatch + audience, already marked
  const tooRecentId = randomUUID();   // failed_to_dispatch + audience, only 30min ago — within grace
  const tenantBTerminalId = randomUUID(); // tenant B 'sent' + audience — must NEVER appear in tenant A results

  beforeAll(async () => {
    const t = await createTwoTestTenants();
    tenantA = t.a;
    tenantB = t.b;

    // Tenant A — seed 5 broadcasts covering all eligibility branches
    await seedBroadcast(tenantA, {
      broadcastId: terminalId,
      status: 'failed_to_dispatch',
      resendAudienceId: 'aud_seed_terminal_1',
      audienceDeletedAt: null,
      updatedAtOffset: -7200, // 2h ago — past the 1h grace cutoff
    });
    await seedBroadcast(tenantA, {
      broadcastId: nonTerminalId,
      status: 'approved',
      resendAudienceId: 'aud_seed_nonterminal',
      audienceDeletedAt: null,
      updatedAtOffset: -7200,
    });
    await seedBroadcast(tenantA, {
      broadcastId: noAudienceId,
      status: 'failed_to_dispatch',
      resendAudienceId: null,
      audienceDeletedAt: null,
      updatedAtOffset: -7200,
    });
    await seedBroadcast(tenantA, {
      broadcastId: alreadyDeletedId,
      status: 'cancelled',
      resendAudienceId: 'aud_seed_already_gone',
      audienceDeletedAt: new Date(Date.now() - 3600_000).toISOString(),
      updatedAtOffset: -7200,
    });
    await seedBroadcast(tenantA, {
      broadcastId: tooRecentId,
      status: 'failed_to_dispatch',
      resendAudienceId: 'aud_seed_too_recent',
      audienceDeletedAt: null,
      updatedAtOffset: -1800, // 30min ago — inside the 1h grace window
    });

    // Tenant B — one terminal broadcast that must never appear in tenant A results
    await seedBroadcast(tenantB, {
      broadcastId: tenantBTerminalId,
      status: 'sent',
      resendAudienceId: 'aud_seed_tenant_b',
      audienceDeletedAt: null,
      updatedAtOffset: -7200,
    });
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  // -------------------------------------------------------------------------
  // AS1: listTerminalBroadcastsWithLiveAudience filters correctly
  // -------------------------------------------------------------------------

  it('listTerminalBroadcastsWithLiveAudience returns ONLY the terminal+past-grace row', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    // grace cutoff = 1h ago
    const graceCutoff = new Date(Date.now() - 3600_000);

    const results = await repo.listTerminalBroadcastsWithLiveAudience(
      tenantA.ctx.slug,
      graceCutoff,
      50,
    );

    // Only `terminalId` should appear:
    //   - nonTerminalId: status='approved' (not terminal)
    //   - noAudienceId: resend_audience_id IS NULL
    //   - alreadyDeletedId: audience_deleted_at IS NOT NULL
    //   - tooRecentId: updated_at < 30min ago, which is > graceCutoff (1h ago)
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      broadcastId: terminalId,
      resendAudienceId: 'aud_seed_terminal_1',
    });
  });

  it('respects the limit parameter', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const graceCutoff = new Date(Date.now() - 3600_000);

    // Only 1 eligible row exists, so limit=0 means nothing returned
    const zeroLimit = await repo.listTerminalBroadcastsWithLiveAudience(
      tenantA.ctx.slug,
      graceCutoff,
      0,
    );
    expect(zeroLimit).toHaveLength(0);
  });

  it('tenant isolation — tenant B broadcasts do not appear in tenant A results', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const repoB = makeDrizzleBroadcastsRepo(tenantB.ctx.slug);
    const graceCutoff = new Date(Date.now() - 3600_000);

    const resultsA = await repoA.listTerminalBroadcastsWithLiveAudience(
      tenantA.ctx.slug,
      graceCutoff,
      50,
    );
    const resultsB = await repoB.listTerminalBroadcastsWithLiveAudience(
      tenantB.ctx.slug,
      graceCutoff,
      50,
    );

    // Tenant A has exactly 1 eligible row (terminalId) and never tenant B's
    const idsA = resultsA.map((r) => r.broadcastId);
    expect(idsA).not.toContain(tenantBTerminalId);

    // Tenant B result must not contain tenant A rows
    const idsB = resultsB.map((r) => r.broadcastId);
    expect(idsB).not.toContain(terminalId);

    // Tenant B has its 'sent' broadcast with an audience, past grace cutoff
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0]?.resendAudienceId).toBe('aud_seed_tenant_b');
  });

  // -------------------------------------------------------------------------
  // AS2: markAudienceDeletedInTx stamps and removes from list (idempotency)
  // -------------------------------------------------------------------------

  it('markAudienceDeletedInTx stamps audience_deleted_at, making the row invisible', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const graceCutoff = new Date(Date.now() - 3600_000);

    // Confirm it appears before the mark
    const before = await repo.listTerminalBroadcastsWithLiveAudience(
      tenantA.ctx.slug,
      graceCutoff,
      50,
    );
    expect(before.map((r) => r.broadcastId)).toContain(terminalId);

    // Mark it
    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.markAudienceDeletedInTx(tx, terminalId);
    });

    // Must no longer appear
    const after = await repo.listTerminalBroadcastsWithLiveAudience(
      tenantA.ctx.slug,
      graceCutoff,
      50,
    );
    expect(after.map((r) => r.broadcastId)).not.toContain(terminalId);
    expect(after).toHaveLength(0);
  });

  it('markAudienceDeletedInTx is idempotent (re-mark is a no-op)', async () => {
    // Self-contained (Finding F): seed a dedicated terminal broadcast, stamp
    // it once within THIS test, then re-stamp and assert no-throw. Does NOT
    // depend on a preceding test having marked `terminalId`, so it stays
    // correct under `-t` filtering / reordering.
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const idempotentId = randomUUID();
    await seedBroadcast(tenantA, {
      broadcastId: idempotentId,
      status: 'failed_to_dispatch',
      resendAudienceId: 'aud_seed_idempotent',
      audienceDeletedAt: null,
      updatedAtOffset: -7200, // 2h ago — past the 1h grace cutoff
    });

    // First mark — stamps audience_deleted_at.
    await runInTenant(tenantA.ctx, async (tx) => {
      await repo.markAudienceDeletedInTx(tx, idempotentId);
    });

    // Second mark on the already-stamped row must be a no-op (no throw).
    await expect(
      runInTenant(tenantA.ctx, async (tx) => {
        await repo.markAudienceDeletedInTx(tx, idempotentId);
      }),
    ).resolves.not.toThrow();
  });
});
