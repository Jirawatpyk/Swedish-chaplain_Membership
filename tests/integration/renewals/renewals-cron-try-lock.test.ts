/**
 * #754 follow-up — `tryRenewalsCronLock` on live Postgres.
 *
 * The seven renewals cron routes moved from the BLOCKING
 * `pg_advisory_xact_lock(hashtextextended('renewals:<x>:'||tenantId, 0))`
 * to this try-lock, which concatenates the key in JS and binds ONE parameter.
 * The unit tests mock `tx.execute`, so only a real server proves the SQL is
 * valid and that both forms hash to the SAME lock (an overlap with a run
 * still on the old form, or a manual blocking lock, must be seen).
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { asTenantContext } from '@/modules/tenants';
import { tryRenewalsCronLock } from '@/lib/renewals-cron-lock';

const TENANT = 'cron-try-lock-test';
const KEY = 'renewals:dispatch:';

describe('tryRenewalsCronLock (#754 follow-up)', () => {
  const holder = postgres(env.database.url, { max: 1, ssl: 'require', connect_timeout: 15 });
  afterAll(() => holder.end());

  it('acquires a free lock', async () => {
    const got = await runInTenant(asTenantContext(TENANT), (tx) =>
      tryRenewalsCronLock(tx, KEY, TENANT),
    );
    expect(got).toBe(true);
  });

  it('sees a lock held through the old blocking expression, at once', async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const holding = holder.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended('${KEY}' || '${TENANT}', 0))`,
      );
      held();
      await released;
    });
    await isHeld;
    try {
      const started = Date.now();
      const got = await runInTenant(asTenantContext(TENANT), (tx) =>
        tryRenewalsCronLock(tx, KEY, TENANT),
      );
      expect(got).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      release();
      await holding;
    }
    // R1 L6: once the holder commits, the lock is free again.
    const again = await runInTenant(asTenantContext(TENANT), (tx) =>
      tryRenewalsCronLock(tx, KEY, TENANT),
    );
    expect(again).toBe(true);
  });
});
