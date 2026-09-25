/**
 * F119 PR-E (migration 0311) — the SQL the Drizzle adapter sends for the FR-021
 * retry-budget anchor, `broadcasts.dispatch_first_failed_at`.
 *
 * Two writes carry the whole contract, and a fake repo can see neither:
 *   - `markDispatchRetryStarted` must keep the FIRST stamp (COALESCE) and land
 *     only on a row still `approved`, without touching `status`;
 *   - `applyTransition` must reset the anchor whenever the status changes (and
 *     on a re-time), so a re-approved or re-dispatched row starts clean.
 *
 * The statements are rendered by a real Drizzle instance over the `pg-proxy`
 * driver, whose callback records them — the exact text and parameters the
 * adapter would send to Neon. What the trigger admits and refuses is proven on
 * live Neon in `tests/integration/broadcasts/dispatch-retry-epoch.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';

const TENANT = 'tenant-retry-epoch';
const BROADCAST_ID = asBroadcastId('7f3c1a52-0000-4000-8000-0000000000e1');
const AT = new Date('2026-09-26T03:00:00.000Z');

interface Sent {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A Drizzle handle whose driver records every statement instead of running it. */
function recordingTx(): { tx: unknown; sent: Sent[] } {
  const sent: Sent[] = [];
  const tx = drizzle(async (sqlText, params) => {
    sent.push({ sql: sqlText, params });
    // `assertTenantBoundTx` probes the GUC first; answer it as runInTenant would.
    if (sqlText.includes("current_setting('app.current_tenant'")) {
      return { rows: [{ current_tenant: TENANT }] };
    }
    return { rows: [] };
  });
  return { tx, sent };
}

function theUpdate(sent: readonly Sent[]): Sent {
  const update = sent.find((s) => /^update "broadcasts"/i.test(s.sql));
  expect(update, 'no UPDATE on broadcasts was sent').toBeDefined();
  return update as Sent;
}

/** The SET list alone, so an assertion about it cannot be satisfied by the WHERE. */
function setClause(sqlText: string): string {
  const m = /\bset\b([\s\S]*?)\bwhere\b/i.exec(sqlText);
  expect(m, 'UPDATE has no SET … WHERE').not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

describe('markDispatchRetryStarted — SQL shape', () => {
  it('stamps with COALESCE (the first failure wins), only while approved, and never writes status', async () => {
    const { tx, sent } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await repo.markDispatchRetryStarted(tx, TENANT as never, BROADCAST_ID, AT);

    // Tenant binding is probed BEFORE the write, as on every tx-taking method.
    expect(sent[0]?.sql).toContain("current_setting('app.current_tenant'");
    const update = theUpdate(sent);
    const set = setClause(update.sql);
    expect(set).toMatch(
      /"dispatch_first_failed_at"\s*=\s*COALESCE\("broadcasts"\."dispatch_first_failed_at",\s*\$\d+::timestamptz\)/,
    );
    expect(set).not.toMatch(/"status"/);
    const where = update.sql.slice(update.sql.search(/\bwhere\b/i));
    expect(where).toMatch(/"broadcasts"\."tenant_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."broadcast_id"\s*=\s*\$\d+/);
    expect(where).toMatch(/"broadcasts"\."status"\s*=\s*\$\d+/);
    expect(update.params).toContain('approved');
    expect(update.params).toContain(TENANT);
    expect(update.params).toContain(BROADCAST_ID);
    expect(update.params).toContain(AT.toISOString());
  });

  it('matching no row (the row left approved) is not an error — there is no attempt left to time', async () => {
    const { tx } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(
      repo.markDispatchRetryStarted(tx, TENANT as never, BROADCAST_ID, AT),
    ).resolves.toBeUndefined();
  });
});

describe('applyTransition — resets the retry anchor', () => {
  it('a status change writes dispatch_first_failed_at = NULL', async () => {
    const { tx, sent } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    // The recorder returns no row, so the adapter reports a lost CAS AFTER the
    // statement was sent — which is all this test reads.
    await expect(
      repo.applyTransition(tx, TENANT as never, BROADCAST_ID, 'changes_requested', {}, 'approved'),
    ).rejects.toBeInstanceOf(BroadcastConcurrentMutationError);

    const update = theUpdate(sent);
    const slot = /"dispatch_first_failed_at"\s*=\s*\$(\d+)/.exec(setClause(update.sql));
    expect(slot, 'the SET list does not write dispatch_first_failed_at').not.toBeNull();
    // Drizzle binds the literal as a parameter; that parameter is the NULL.
    expect(update.params[Number(slot?.[1]) - 1]).toBeNull();
  });

  it('a re-time (approved → approved with a new scheduledFor) resets it too — a new time is a new attempt', async () => {
    const { tx, sent } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    await expect(
      repo.applyTransition(tx, TENANT as never, BROADCAST_ID, 'approved', { scheduledFor: AT }, 'approved'),
    ).rejects.toBeInstanceOf(BroadcastConcurrentMutationError);

    expect(setClause(theUpdate(sent).sql)).toMatch(/"dispatch_first_failed_at"\s*=/);
  });

  it('a same-status write that is not a re-time leaves the anchor alone', async () => {
    const { tx, sent } = recordingTx();
    const repo = makeDrizzleBroadcastsRepo(TENANT);

    // The reminder-stage bump on an awaiting row: same status, no new time.
    await expect(
      repo.applyTransition(
        tx,
        TENANT as never,
        BROADCAST_ID,
        'awaiting_member_approval',
        { memberReminderStage: 1 },
        'awaiting_member_approval',
      ),
    ).rejects.toBeInstanceOf(BroadcastConcurrentMutationError);

    expect(setClause(theUpdate(sent).sql)).not.toMatch(/"dispatch_first_failed_at"/);
  });
});
