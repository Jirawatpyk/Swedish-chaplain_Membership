/**
 * Phase 3F.11.5 (Round 2 Finding 5 closure) — live-Neon integration
 * test for `pgAdvisoryLockAdapter`. Round 1 pr-test-analyzer flagged
 * that the lock adapter had unit-test coverage but no integration test
 * exercising the actual Postgres `pg_try_advisory_xact_lock` semantics
 * end-to-end.
 *
 * Verifies (a) lock is held across a tx, (b) auto-releases on commit
 * (allowing a follow-up acquire), (c) auto-releases on rollback.
 *
 * Runs on live Neon Singapore via `DATABASE_URL`. Each test uses a
 * UNIQUE lockKey so concurrent runs don't collide. No fixture seed
 * needed — advisory locks are just (bigint → tx) and don't touch
 * any tenant rows.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { pgAdvisoryLockAdapter } from '@/modules/broadcasts/infrastructure/pg-advisory-lock-adapter';
import { asTxToken } from '@/modules/broadcasts/application/ports/advisory-lock-port';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';

describe.runIf(RUN_INTEGRATION)(
  'pgAdvisoryLockAdapter integration (Phase 3F.11.5 / Finding 5)',
  () => {
    it('refuses to acquire when tx argument is null', async () => {
      // Defence-in-depth: the adapter throws synchronously if the
      // caller forgot to wrap in withTx. Without this guard, the
      // adapter would run pg_try_advisory_xact_lock outside any tx,
      // making the lock immediately released and SC-007 broken.
      await expect(
        pgAdvisoryLockAdapter.acquire(null, 'test-key'),
      ).rejects.toThrow(/requires a tx argument/);
    });

    it('returns {acquired:true} inside a fresh tx', async () => {
      const lockKey = `test-lock-${randomUUID()}`;
      const result = await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        return await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
      });
      expect(result.acquired).toBe(true);
    });

    it('lock auto-releases on tx commit — next tx can acquire same key', async () => {
      const lockKey = `test-lock-commit-${randomUUID()}`;
      // First tx: acquire + COMMIT
      const first = await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        return await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
      });
      expect(first.acquired).toBe(true);
      // Second tx: should ALSO acquire since first tx already committed
      const second = await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        return await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
      });
      expect(second.acquired).toBe(true);
    });

    it('lock auto-releases on tx rollback — next tx can acquire same key', async () => {
      const lockKey = `test-lock-rollback-${randomUUID()}`;
      // First tx: acquire + force ROLLBACK by throwing
      await expect(
        runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
          const r = await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
          expect(r.acquired).toBe(true);
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');
      // Second tx: should ALSO acquire since rollback released the lock
      const second = await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        return await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
      });
      expect(second.acquired).toBe(true);
    });

    it('same lockKey acquired TWICE inside the same tx → both return true (re-entrant within tx scope)', async () => {
      // pg_try_advisory_xact_lock is re-entrant within the same tx —
      // a second acquire of the same key inside the same tx still
      // returns true (Postgres tracks the acquisition count). This is
      // semantically meaningful for the F71A use cases: a nested call
      // (e.g., retry-failed-batches calling into a helper that ALSO
      // tries to acquire the same lock) does NOT deadlock or fail.
      const lockKey = `test-lock-reentrant-${randomUUID()}`;
      const results = await runInTenant(
        asTenantContext(TEST_TENANT),
        async (tx) => {
          const first = await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
          const second = await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
          return { first: first.acquired, second: second.acquired };
        },
      );
      expect(results.first).toBe(true);
      expect(results.second).toBe(true);
    });

    // Phase 3F.11.11 (Round 3 SC-007 re-attempt) — concurrent-tx
    // semantic with a STANDALONE postgres-js pool to bypass the
    // shared pool serialisation that caused the earlier attempt to
    // time out. The first tx still uses `runInTenant` (production
    // code path); the second uses its own dedicated connection so
    // it's not queued behind the first tx in the shared pool.
    it('concurrent acquire from DIFFERENT tx on same key → second tx sees {acquired:false}', async () => {
      const lockKey = `test-lock-concurrent-${randomUUID()}`;
      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl === undefined) throw new Error('DATABASE_URL required');
      // Standalone pool — single connection, separate from runInTenant's pool.
      const standaloneSql = postgres(databaseUrl, { max: 1 });

      let releaseFirst!: () => void;
      const firstReleased = new Promise<void>((res) => {
        releaseFirst = res;
      });
      const firstAcquired: { value?: boolean } = {};
      const secondAcquired: { value?: boolean } = {};

      // First tx — uses production path, acquires the lock + holds open
      const firstTxPromise = runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        const r = await pgAdvisoryLockAdapter.acquire(asTxToken(tx), lockKey);
        firstAcquired.value = r.acquired;
        // Hold the tx open until released by the test
        await firstReleased;
      });

      // Give first tx time to acquire the lock before second tx tries
      await new Promise((r) => setTimeout(r, 200));

      try {
        // Second tx — standalone pool, dedicated connection. The
        // pg_try_advisory_xact_lock is non-blocking so the call returns
        // immediately with `false` if the lock is held elsewhere.
        await standaloneSql.begin(async (sql) => {
          const rows = (await sql`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired
          `) as unknown as Array<{ acquired: boolean }>;
          secondAcquired.value = rows[0]?.acquired === true;
        });

        expect(firstAcquired.value).toBe(true);
        expect(secondAcquired.value).toBe(false);
      } finally {
        // Release first tx + clean up the standalone pool
        releaseFirst();
        await firstTxPromise;
        await standaloneSql.end();
      }
    }, 15_000);
  },
);
