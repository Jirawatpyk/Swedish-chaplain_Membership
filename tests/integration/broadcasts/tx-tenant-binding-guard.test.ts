/**
 * Round 2 R2-4 — **the APPLICATION half of two-layer tenant isolation had no
 * test anywhere in the repo.**
 *
 * Constitution Principle I requires isolation at BOTH layers, with a
 * cross-tenant integration test as a Review-Gate blocker. The database half is
 * well covered (RLS + FORCE policies, and the cross-tenant probes in the erasure
 * and referenced-audiences suites). The application half is
 * `assertTenantBoundTx`, called at **17 sites** in `drizzle-broadcasts-repo.ts`
 * before every mutation — and `grep "tx tenant mismatch" tests/` returned ZERO
 * hits across the whole repository.
 *
 * Why the existing probes cannot cover it: they build the repo and the
 * transaction for the SAME tenant, so the guard's comparison is always equal and
 * its throwing branches are unreachable. The refusal was structurally
 * unexercised, which is a different thing from untested — a test that never
 * reaches a branch cannot notice when someone deletes it.
 *
 * Both refusal modes are driven here:
 *
 *   1. a repo bound to tenant A handed a tx bound to tenant B — the mismatch;
 *   2. a repo handed a tx with NO `app.current_tenant` at all — the unbound
 *      case, which is the one that matters most, because a pool connection
 *      without the GUC is where RLS silently writes nothing (a failure mode this
 *      repo has met before).
 *
 * Deliberately asserts the ERROR TEXT's distinguishing phrase, not just "it
 * threw": the two modes point an operator at different causes ("wrong tenant" vs
 * "not inside runInTenant"), and collapsing them was the S15-class defect this
 * codebase keeps finding.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';

const RUN_INTEGRATION = process.env['DATABASE_URL'] !== undefined;

const TENANT_A = 'swecham';
const TENANT_B = 'jcc';
const BROADCAST_ID = asBroadcastId('55555555-5555-4555-8555-555555555555');

describe('assertTenantBoundTx — the application layer of Principle I', () => {
  it('refuses a tx bound to a DIFFERENT tenant than the repo', async () => {
    if (!RUN_INTEGRATION) return;
    // The repo is bound to A; the transaction will carry B.
    const repoForA = makeDrizzleBroadcastsRepo(TENANT_A);

    await expect(
      runInTenant(asTenantContext(TENANT_B), async (tx) => {
        // Any mutation reaches the guard before it reaches SQL. `attachAudienceId`
        // is used because it is one of the two writes 108 Phase 9 added a
        // compare-and-set to, so this also pins that the guard runs FIRST — a
        // cross-tenant write must be refused by the application before the CAS
        // gets a chance to report a concurrency problem instead.
        await repoForA.attachAudienceId(tx, TENANT_A, BROADCAST_ID, 'aud-x');
      }),
    ).rejects.toThrow(/tx tenant mismatch/);
  }, 30_000);

  it('names BOTH tenants in the refusal, so an operator knows which way round it was', async () => {
    if (!RUN_INTEGRATION) return;
    const repoForA = makeDrizzleBroadcastsRepo(TENANT_A);

    const err = await runInTenant(asTenantContext(TENANT_B), async (tx) =>
      repoForA
        .attachAudienceId(tx, TENANT_A, BROADCAST_ID, 'aud-x')
        .then(() => null)
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
    );

    expect(err).toContain(TENANT_A);
    expect(err).toContain(TENANT_B);
    // And it names the caller, because 17 sites share this guard and a bare
    // message would not say which write was refused.
    expect(err).toContain('attachAudienceId');
  }, 30_000);

  /**
   * The unbound case. A raw `db` handle has no `app.current_tenant`, which is
   * exactly the shape of the recurring bug this repo documents: a tenant-scoped
   * repo method reaching for the pool-global `db` gets a connection with no GUC,
   * where RLS+FORCE policies match nothing and a write silently disappears.
   */
  it('refuses a tx that is not inside a runInTenant scope at all', async () => {
    if (!RUN_INTEGRATION) return;
    const repoForA = makeDrizzleBroadcastsRepo(TENANT_A);

    await expect(
      db.transaction(async (tx) => {
        await repoForA.attachAudienceId(
          tx as never,
          TENANT_A,
          BROADCAST_ID,
          'aud-x',
        );
      }),
    ).rejects.toThrow(/NOT inside a runInTenant scope/);
  }, 30_000);

  /**
   * Positive control. Without it, a guard that threw unconditionally would
   * satisfy all three cases above and break every write in the system — the
   * direction a refusal tightened after an incident usually fails in.
   *
   * Rolled back deliberately: this asserts the guard ADMITS the matching pair,
   * not that the write lands.
   */
  it('ADMITS a tx bound to the same tenant as the repo', async () => {
    if (!RUN_INTEGRATION) return;
    const repoForA = makeDrizzleBroadcastsRepo(TENANT_A);
    const sentinel = new Error('rollback-after-guard');

    await expect(
      runInTenant(asTenantContext(TENANT_A), async (tx) => {
        // Reaches past the guard and runs the UPDATE. The broadcast id does not
        // exist, so the compare-and-set matches 0 rows and the repo throws its
        // own concurrency error — which is proof the guard let us through, since
        // a mismatch would have thrown a different message first.
        await repoForA
          .attachAudienceId(tx, TENANT_A, BROADCAST_ID, 'aud-x')
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            expect(msg).not.toMatch(/tenant mismatch|NOT inside a runInTenant/);
            throw sentinel;
          });
        throw sentinel;
      }),
    ).rejects.toThrow(sentinel);

    // Nothing was left behind by the rolled-back transaction.
    const after = (await runInTenant(asTenantContext(TENANT_A), async (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM broadcasts WHERE broadcast_id = ${BROADCAST_ID as unknown as string}`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(0);
  }, 30_000);
});
