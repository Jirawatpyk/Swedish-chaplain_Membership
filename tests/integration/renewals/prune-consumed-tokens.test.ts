/**
 * F8 Phase 9 retrofit (PR #25) — `pruneConsumedTokens` integration test.
 *
 * Exercises the REAL Drizzle adapter against live Neon Singapore to
 * verify three properties that unit tests with mocked deps cannot:
 *
 *   1. **Cross-tenant scope**: tenant A's prune MUST NOT delete
 *      tenant B's rows. The DELETE is scoped by RLS+FORCE policy on
 *      `consumed_link_tokens` via the `app.current_tenant` GUC set by
 *      `runInTenant`. Without this property, a single prune pass
 *      could wipe replay-protection records across the whole platform.
 *   2. **Cutoff exclusivity**: rows with `consumed_at < cutoff` are
 *      deleted; rows with `consumed_at >= cutoff` are kept. Catches a
 *      future refactor that flips the comparison or uses an inclusive
 *      bound.
 *   3. **Idempotency**: re-running the same prune returns 0 rows
 *      deleted. cron-job.org timeout-window retries are safe.
 *
 * Constitution Principle II requirement: any new DB-touching use-case
 * MUST have an integration test against real Postgres. Unit-test
 * coverage with mocked adapters is insufficient because RLS scope +
 * actual DELETE semantics live in the database, not the application
 * layer.
 *
 * Setup: two test tenants created via `createTwoTestTenants` helper.
 * Each receives 3 token rows with controlled `consumed_at` timestamps
 * (one old past cutoff, one new before cutoff, one borderline at the
 * cutoff itself). Helper auto-cleans `consumed_link_tokens` rows via
 * inline DELETE in afterAll (the shared `test-tenant.ts` cleanup
 * helper does not cover this table).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID, randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { consumedLinkTokens } from '@/modules/renewals/infrastructure/schema-consumed-link-tokens';
import { makeRenewalsDeps } from '@/modules/renewals';
import { pruneConsumedTokens } from '@/modules/renewals/application/use-cases/prune-consumed-tokens';
import {
  createTestTenant,
  type TestTenant,
} from '../helpers/test-tenant';

// Fixed wall-clock for deterministic cutoff math. 60-day cutoff =
// 2026-03-12T00:00:00Z relative to this NOW.
const NOW = new Date('2026-05-11T00:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);

// `consumed_at` values for the 3 seed rows per tenant.
// OLD: 1 day older than cutoff → SHOULD be pruned
// BORDERLINE: exactly at cutoff → kept (DELETE uses `<` not `<=`)
// NEW: 1 day inside the retention window → kept
const OLD_TS = new Date(CUTOFF.getTime() - 24 * 60 * 60 * 1000);
const BORDERLINE_TS = CUTOFF; // exactly at the cutoff boundary
const NEW_TS = new Date(CUTOFF.getTime() + 24 * 60 * 60 * 1000);

interface SeededRows {
  readonly oldSha: Buffer;
  readonly borderlineSha: Buffer;
  readonly newSha: Buffer;
  readonly memberId: string;
  readonly cycleId: string;
}

async function seedTokensForTenant(tenantSlug: string): Promise<SeededRows> {
  const oldSha = randomBytes(32);
  const borderlineSha = randomBytes(32);
  const newSha = randomBytes(32);
  const memberId = randomUUID();
  const cycleId = randomUUID();

  await db.insert(consumedLinkTokens).values([
    {
      tenantId: tenantSlug,
      tokenSha256: oldSha,
      consumedAt: OLD_TS,
      consumedByMemberId: memberId,
      cycleId,
    },
    {
      tenantId: tenantSlug,
      tokenSha256: borderlineSha,
      consumedAt: BORDERLINE_TS,
      consumedByMemberId: memberId,
      cycleId,
    },
    {
      tenantId: tenantSlug,
      tokenSha256: newSha,
      consumedAt: NEW_TS,
      consumedByMemberId: memberId,
      cycleId,
    },
  ]);

  return { oldSha, borderlineSha, newSha, memberId, cycleId };
}

async function countTokensForTenant(tenantSlug: string): Promise<number> {
  const rows = await db
    .select({ token: consumedLinkTokens.tokenSha256 })
    .from(consumedLinkTokens)
    .where(eq(consumedLinkTokens.tenantId, tenantSlug));
  return rows.length;
}

async function rowExists(
  tenantSlug: string,
  sha: Buffer,
): Promise<boolean> {
  const rows = await db
    .select({ token: consumedLinkTokens.tokenSha256 })
    .from(consumedLinkTokens)
    .where(
      and(
        eq(consumedLinkTokens.tenantId, tenantSlug),
        eq(consumedLinkTokens.tokenSha256, sha),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

describe('pruneConsumedTokens — integration (Phase 9 retrofit)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let seededA: SeededRows;
  let seededB: SeededRows;

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    seededA = await seedTokensForTenant(tenantA.ctx.slug);
    seededB = await seedTokensForTenant(tenantB.ctx.slug);
  });

  afterAll(async () => {
    // Clean up consumed_link_tokens rows for both tenants — the shared
    // `test-tenant.ts` cleanup helper does not cover this table (F8
    // Phase 9 retrofit; helper extension is a follow-up). Inline DELETE
    // runs as `neondb_owner` (BYPASS RLS) so it sees all rows.
    await db
      .delete(consumedLinkTokens)
      .where(eq(consumedLinkTokens.tenantId, tenantA.ctx.slug));
    await db
      .delete(consumedLinkTokens)
      .where(eq(consumedLinkTokens.tenantId, tenantB.ctx.slug));
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  it('prunes only rows with consumed_at < cutoff for the calling tenant', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await pruneConsumedTokens(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: 'integration-test-prune-1',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Exactly 1 row (`OLD_TS`) is < cutoff. BORDERLINE is at the
      // cutoff itself (not <); NEW is past. Pruned count must be 1.
      expect(result.value.pruned).toBe(1);
      expect(result.value.cutoffIso).toBe(CUTOFF.toISOString());
    }
  });

  it('cross-tenant scope — tenant B rows untouched by tenant A prune', async () => {
    // After the prior test pruned tenant A, tenant B still has all 3
    // rows. This is the Principle I clause 1 + 2 invariant: RLS+FORCE
    // policy on `consumed_link_tokens` scoping by
    // `app.current_tenant` prevents cross-tenant data wipe even when
    // a use-case calls DELETE.
    const tenantBCount = await countTokensForTenant(tenantB.ctx.slug);
    expect(tenantBCount).toBe(3);
    // Each of the 3 expected rows is present.
    expect(await rowExists(tenantB.ctx.slug, seededB.oldSha)).toBe(true);
    expect(await rowExists(tenantB.ctx.slug, seededB.borderlineSha)).toBe(
      true,
    );
    expect(await rowExists(tenantB.ctx.slug, seededB.newSha)).toBe(true);
  });

  it('borderline + new rows kept for tenant A (cutoff is exclusive)', async () => {
    // Tenant A's BORDERLINE row (consumed_at === cutoff) and NEW row
    // (consumed_at > cutoff) must remain after the prune.
    expect(await rowExists(tenantA.ctx.slug, seededA.oldSha)).toBe(false);
    expect(await rowExists(tenantA.ctx.slug, seededA.borderlineSha)).toBe(
      true,
    );
    expect(await rowExists(tenantA.ctx.slug, seededA.newSha)).toBe(true);
  });

  it('idempotent — re-running prune returns 0 pruned', async () => {
    // Second pass with the same `now`/cutoff. The OLD row was already
    // deleted in the first test; the BORDERLINE/NEW rows are kept by
    // the cutoff math. Expected delta: 0.
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await pruneConsumedTokens(deps, {
      tenantId: tenantA.ctx.slug,
      correlationId: 'integration-test-prune-2',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pruned).toBe(0);
    }
  });

  it('prune for tenant B works independently after tenant A prune', async () => {
    // Tenant B was untouched until now. Run the same prune against
    // tenant B and verify exactly 1 row gets pruned (the OLD one).
    const deps = makeRenewalsDeps(tenantB.ctx.slug);
    const result = await pruneConsumedTokens(deps, {
      tenantId: tenantB.ctx.slug,
      correlationId: 'integration-test-prune-3',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.pruned).toBe(1);
    // Tenant B's OLD row is now gone; BORDERLINE + NEW remain.
    expect(await rowExists(tenantB.ctx.slug, seededB.oldSha)).toBe(false);
    expect(await rowExists(tenantB.ctx.slug, seededB.borderlineSha)).toBe(
      true,
    );
    expect(await rowExists(tenantB.ctx.slug, seededB.newSha)).toBe(true);
  });

  it('runInTenant adapter wrap — DELETE goes through RLS GUC binding', async () => {
    // Defence-in-depth assertion: even if we manually bind a WRONG
    // tenant context and try to use the adapter, the RLS policy
    // prevents tenant A's DELETE from touching tenant B's rows.
    // `runInTenant(B)` then calling the use-case for tenant A would
    // be a programmer error caught by the use-case input validation
    // (the use-case forwards `input.tenantId` to logs only; the
    // actual DB scope comes from the adapter's `runInTenant(tenant)`
    // which binds `tenant.slug`).
    // Here we verify the adapter's runInTenant uses the constructor-
    // bound tenant, not any caller-supplied override.
    const tenantBSlug = tenantB.ctx.slug;
    const tenantBCountBefore = await countTokensForTenant(tenantBSlug);
    const depsForA = makeRenewalsDeps(tenantA.ctx.slug);
    // Even though we pass tenantBSlug in the use-case input, the
    // adapter is constructed with tenant A's slug → the runInTenant
    // wrap inside the adapter binds tenant A → DELETE scopes to
    // tenant A's rows only (which are already pruned from the first
    // test). Tenant B's remaining row count MUST be unchanged.
    await pruneConsumedTokens(depsForA, {
      tenantId: tenantBSlug, // ignored by adapter — adapter binds tenant A
      correlationId: 'integration-test-prune-4-misrouted-input',
      now: NOW,
    });
    const tenantBCountAfter = await countTokensForTenant(tenantBSlug);
    expect(tenantBCountAfter).toBe(tenantBCountBefore);
  });
});
