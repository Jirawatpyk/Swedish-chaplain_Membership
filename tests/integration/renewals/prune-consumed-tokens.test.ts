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
 * cutoff itself). The shared `test-tenant.ts` helper handles
 * `consumed_link_tokens` cleanup (Round 2 review-fix B extended the
 * helper to include this table).
 *
 * **Sequential test contract**: tests within this `describe.sequential`
 * block share state across executions. Example dependency: test 6
 * (defence-in-depth misroute) assumes tenant A's old row was already
 * deleted by test 1, so the misrouted call can assert "no rows
 * change" on tenant B without test 1's prune side-effect confounding
 * the assertion. Vitest's default within-describe ordering is
 * sequential, but `describe.sequential` is used explicitly to defend
 * against a future `sequence.concurrent: true` root config flip
 * (`describe.sequential` does NOT prevent a child `it.concurrent`
 * opt-in from running concurrently — Vitest semantics).
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

describe.sequential('pruneConsumedTokens — integration (Phase 9 retrofit)', () => {
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
    // `test-tenant.ts` cleanup helper now covers `consumed_link_tokens`
    // (Round 2 review-fix B). Calling tenant.cleanup() is sufficient —
    // no inline DELETE needed.
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

  it('defence-in-depth — adapter-bound tenant overrides input.tenantId for DB scope', async () => {
    // **Intent**: This is NOT testing a bug — it is a DEMONSTRATION
    // that the system is robust against a specific class of
    // programmer error.
    //
    // Scenario being defended against: a caller misroutes the
    // use-case by constructing `deps` for tenant A but passing
    // `input.tenantId = tenantB`. This is a contract-violating
    // mistake (the route handler always derives both from
    // `env.tenant.slug`, so they should match), but if it ever
    // happened in code, what would the blast radius be?
    //
    // **The invariant**: the adapter's `runInTenant(tenant, …)` wrap
    // binds the **constructor-bound** tenant — `input.tenantId` is
    // only used for logging/audit context, NEVER for DB scope. So
    // even with a misrouted input, DELETE scopes to tenant A's rows
    // only. Tenant B is safe.
    //
    // **Why this matters**: tenant A's rows were already pruned in
    // test 1. The misrouted call should be a no-op. If a future
    // refactor accidentally passes `input.tenantId` into a `WHERE
    // tenant_id = $1` predicate at the adapter layer (overriding
    // the GUC), tenant B's rows would be deleted — silent cross-
    // tenant data loss. This test pins the GUC-not-input scoping
    // contract.
    const tenantBSlug = tenantB.ctx.slug;
    const tenantASlug = tenantA.ctx.slug;
    const tenantACountBefore = await countTokensForTenant(tenantASlug);
    const tenantBCountBefore = await countTokensForTenant(tenantBSlug);
    const depsForA = makeRenewalsDeps(tenantASlug);
    // R3 review-fix M3 — capture + assert `result.ok` so the
    // assertion below tests the named invariant (adapter ignores
    // input.tenantId for DB scope) rather than passing for an
    // unrelated reason like "use-case input validation rejected the
    // misroute" or "adapter silently threw". Also assert
    // `result.value.pruned === 0` because tenant A's old row was
    // already deleted by test 1; the misroute should be a true no-op.
    const result = await pruneConsumedTokens(depsForA, {
      tenantId: tenantBSlug, // intentional misroute — adapter ignores it
      correlationId: 'integration-test-prune-defence-in-depth',
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pruned).toBe(0);
    }
    // Symmetric no-side-effect contract — both tenants' counts must
    // be unchanged. Without the tenant A check, a future regression
    // where the adapter deletes from BOTH tenants (e.g. due to BYPASS
    // RLS fallback) would still pass the tenant-B-only assertion.
    const tenantACountAfter = await countTokensForTenant(tenantASlug);
    const tenantBCountAfter = await countTokensForTenant(tenantBSlug);
    expect(tenantACountAfter).toBe(tenantACountBefore);
    expect(tenantBCountAfter).toBe(tenantBCountBefore);
  });
});
