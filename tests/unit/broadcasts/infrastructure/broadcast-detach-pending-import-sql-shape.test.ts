/**
 * The SQL the Drizzle adapter sends for `detachPendingAudienceImport` — the
 * write a tick-2 HOLD makes on the import leg, after it deleted the tick-1
 * Resend audience.
 *
 * A fake repo cannot see the contract, which is all in the statement:
 *   - the four import-leg columns are written NULL together (0299's coherence
 *     CHECK requires `audience_import_id` and `audience_import_submitted_at` to
 *     be NULL or set together) and `status` is never written;
 *   - `resend_broadcast_id` is written NULL too: a held row may carry a
 *     pre-send id whose probe answered draft / cancelled / not_found, which
 *     the hold reclaimed at Resend before this write;
 *   - it is a compare-and-set on ALL THREE ids the hold read (the broadcast id
 *     NULL-safe: `IS NOT DISTINCT FROM`, so a NULL matches a NULL), on a row
 *     still `approved`, with no completion stamp;
 *   - zero rows matched answers `false` (a lost CAS), never a throw.
 *
 * Rendered by a real Drizzle instance over `pg-proxy`, as in
 * `broadcast-dispatch-retry-epoch-sql-shape.test.ts`. What Postgres admits is
 * proven on live Neon in `tests/integration/broadcasts/eblast-send-time-standing.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';

const TENANT = 'tenant-detach-import';
const BROADCAST_ID = asBroadcastId('7f3c1a52-0000-4000-8000-0000000000d1');
const EXPECTED = { importId: 'imp-held', resendAudienceId: 'aud-held', resendBroadcastId: 'rb-held' } as const;

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function recordingTx(returned: unknown[][] = []): { tx: unknown; sent: Sent[] } {
  const sent: Sent[] = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    if (sqlText.includes("current_setting('app.current_tenant'")) {
      return { rows: [{ current_tenant: TENANT }] };
    }
    if (/\breturning\b/i.test(sqlText)) return { rows: returned };
    return { rows: [] };
  });
  return { tx, sent };
}

function theUpdate(sent: readonly Sent[]): Sent {
  const update = sent.find((s) => /^update "broadcasts"/i.test(s.sql));
  expect(update, 'no UPDATE on broadcasts was sent').toBeDefined();
  return update as Sent;
}

describe('detachPendingAudienceImport — SQL shape', () => {
  it('NULLs the four import-leg columns and the broadcast id, never status, CAS on all three ids, approved, not completed', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.detachPendingAudienceImport(tx, TENANT as never, BROADCAST_ID, EXPECTED)).resolves.toBe(true);

    expect(sent[0]?.sql).toContain("current_setting('app.current_tenant'");
    const update = theUpdate(sent);
    const set = /\bset\b([\s\S]*?)\bwhere\b/i.exec(update.sql)?.[1] ?? '';
    for (const col of [
      'resend_audience_id',
      'resend_broadcast_id',
      'audience_import_id',
      'audience_import_submitted_at',
      'audience_import_completed_at',
    ]) {
      const slot = new RegExp(`"${col}"\\s*=\\s*\\$(\\d+)`).exec(set);
      expect(slot, `the SET list does not write ${col}`).not.toBeNull();
      expect(update.params[Number(slot?.[1]) - 1]).toBeNull();
    }
    expect(set).not.toMatch(/"status"/);
    const where = update.sql.slice(update.sql.search(/\bwhere\b/i));
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."broadcast_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."status"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."audience_import_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."resend_audience_id"\s*=\s*\$\d+/);
    const rbSlot = /"resend_broadcast_id"\s+is\s+not\s+distinct\s+from\s+\$(\d+)/i.exec(where);
    expect(rbSlot, 'the broadcast id is not compared NULL-safe').not.toBeNull();
    expect(update.params[Number(rbSlot?.[1]) - 1]).toBe('rb-held');
    expect(where).toMatch(/"broadcasts"\."audience_import_completed_at"\s+is\s+null/i);
    expect(update.params).toEqual(expect.arrayContaining([TENANT, BROADCAST_ID, 'approved', 'imp-held', 'aud-held']));
  });

  it('a row with NO broadcast id is matched by a NULL parameter, not by a separate IS NULL arm', async () => {
    const { tx, sent } = recordingTx([[BROADCAST_ID]]);
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.detachPendingAudienceImport(tx, TENANT as never, BROADCAST_ID, { ...EXPECTED, resendBroadcastId: null });

    const update = theUpdate(sent);
    const where = update.sql.slice(update.sql.search(/\bwhere\b/i));
    const rbSlot = /"resend_broadcast_id"\s+is\s+not\s+distinct\s+from\s+\$(\d+)/i.exec(where);
    expect(rbSlot).not.toBeNull();
    expect(update.params[Number(rbSlot?.[1]) - 1]).toBeNull();
  });

  it('matching no row (the CAS lost) answers false, not a throw', async () => {
    const { tx } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(repo.detachPendingAudienceImport(tx, TENANT as never, BROADCAST_ID, EXPECTED)).resolves.toBe(false);
  });
});
