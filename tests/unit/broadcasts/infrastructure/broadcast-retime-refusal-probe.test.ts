/**
 * Spec 140 s2b review round 4 (code-review #2, #3; reliability LOW-2) — the
 * repo backstop for a refused re-time. A non-holder same-status re-time that
 * matches 0 rows probes the row ONCE and reads no clock: the row where the
 * caller expected it, with a token set, is `LEASE_HELD` even if that lease
 * expired between the UPDATE and the probe (a second clock read used to turn
 * that race into status drift). Anything else is drift, reported with the
 * PROBED status.
 *
 * The race cannot be staged on live Postgres (the UPDATE and the probe run
 * back to back in one tx), so the statements are rendered by a real Drizzle
 * instance over `pg-proxy`, and the probe answers a token whose lease has
 * already ended — the state the race leaves. Live Neon proves the drift arm
 * (`dispatch-lease-repo.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';

const TENANT = 'tenant-retime-probe';
const BROADCAST_ID = asBroadcastId('7f3c1a52-0000-4000-8000-0000000000e1');

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** The UPDATE matches no row; the probe SELECT answers `probeRow` (positional, as pg-proxy expects). */
function refusingTx(probeRow: unknown[] | null): { tx: unknown; sent: Sent[] } {
  const sent: Sent[] = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    if (sqlText.includes("current_setting('app.current_tenant'")) {
      return { rows: [{ current_tenant: TENANT }] };
    }
    if (/^select/i.test(sqlText)) return { rows: probeRow === null ? [] : [probeRow] };
    return { rows: [] };
  });
  return { tx, sent };
}

async function retime(tx: unknown): Promise<unknown> {
  const repo = makeDrizzleBroadcastsRepo(TENANT);
  return repo
    .applyTransition(tx, TENANT as never, BROADCAST_ID, 'approved', { scheduledFor: new Date('2026-11-02T03:00:00Z') }, 'approved', null)
    .then(
      () => null,
      (e: unknown) => e,
    );
}

describe('spec 140 s2b — the refused re-time probe (review round 4)', () => {
  it('a refused re-time whose lease expires before the probe still reports lease_held', async () => {
    // The probe reads the row where the caller expected it, with a token set
    // (its expiry already past): the lease is what refused the UPDATE.
    const { tx, sent } = refusingTx(['approved', 'aaaaaaaa-0000-4000-8000-0000000000aa']);
    const thrown = await retime(tx);
    expect(thrown).toBeInstanceOf(BroadcastConcurrentMutationError);
    expect((thrown as BroadcastConcurrentMutationError).observedStatus).toBe('lease_held');
    expect((thrown as BroadcastConcurrentMutationError).rowStatus).toBe('approved');
    // One probe, and it reads no clock.
    const probes = sent.filter((s) => /^select/i.test(s.sql) && !s.sql.includes('current_setting'));
    expect(probes).toHaveLength(1);
    expect(probes[0]!.sql).not.toMatch(/clock_timestamp|now\(\)/i);
  });

  it('a probe that finds the row in another status reports that status (drift), not lease_held', async () => {
    const { tx } = refusingTx(['cancelled', null]);
    const thrown = await retime(tx);
    expect((thrown as BroadcastConcurrentMutationError).observedStatus).toBe('cancelled');
  });
});
