/**
 * Spec 140 s2c review round 2 — the shared orphan outcome table
 * (`_settle-orphan-at-resend.ts`), the two rows it gained:
 *   - code-review #4: a broadcast DELETE 404 is CONFIRMED before the row
 *     settles `absent` — wait `REPROBE_PAUSE_MS`, then one
 *     `retrieveBroadcastOnce`; only `not_found` settles, anything else is
 *     left for the next run (the import leg's "two not-founds" rule);
 *   - code-review #2: a broadcast orphan whose id a sent row holds settles
 *     `superseded` with no Resend call.
 * The rest of the table is pinned through its two callers
 * (`cleanup-orphaned-audiences-drain.test.ts`,
 * `cancel-in-flight-broadcasts-for-member.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import { settleOrphanAtResend } from '@/modules/broadcasts/application/use-cases/_settle-orphan-at-resend';
import { REPROBE_PAUSE_MS } from '@/modules/broadcasts/application/use-cases/_reprobe-pause';

type Probe = { kind: 'present'; status: string } | { kind: 'not_found' } | { kind: 'retryable' };

function gateway(deleted: string, probe: Probe) {
  const calls: string[] = [];
  return {
    calls,
    gw: {
      deleteBroadcastOnce: vi.fn(async (id: string) => {
        calls.push(`delete:${id}`);
        return { kind: deleted };
      }),
      retrieveBroadcastOnce: vi.fn(async (id: string) => {
        calls.push(`get:${id}`);
        return probe;
      }),
      deleteAudience: vi.fn(async (id: string) => {
        calls.push(`deleteAudience:${id}`);
      }),
    },
    pause: vi.fn(async (ms: number) => {
      calls.push(`pause:${ms}`);
    }),
  };
}

const row = { resourceType: 'broadcast' as const, resourceId: 'rb-1', heldBySentRow: false };

describe('settleOrphanAtResend — review round 2', () => {
  it('[code-review #4] a 404 then a GET draft is not absent', async () => {
    const g = gateway('absent', { kind: 'present', status: 'draft' });
    const answer = await settleOrphanAtResend(g.gw as never, row, g.pause);
    expect(answer).toEqual({ kind: 'undecided', answer: 'absent_probe_draft' });
    expect(g.calls).toEqual(['delete:rb-1', `pause:${REPROBE_PAUSE_MS}`, 'get:rb-1']);
  });

  it('[code-review #4] a 404 then a GET retryable is not absent either', async () => {
    const g = gateway('absent', { kind: 'retryable' });
    expect(await settleOrphanAtResend(g.gw as never, row, g.pause)).toEqual({ kind: 'undecided', answer: 'absent_probe_retryable' });
  });

  it('[code-review #4] a 404 confirmed by a GET 404 after REPROBE_PAUSE_MS settles absent', async () => {
    const g = gateway('absent', { kind: 'not_found' });
    expect(await settleOrphanAtResend(g.gw as never, row, g.pause)).toEqual({ kind: 'settled', outcome: 'absent' });
    expect(g.calls).toEqual(['delete:rb-1', `pause:${REPROBE_PAUSE_MS}`, 'get:rb-1']);
  });

  it('[code-review #2] an orphan whose id a sent row holds is superseded, not handed, with no Resend call', async () => {
    const g = gateway('forbidden', { kind: 'present', status: 'sent' });
    const answer = await settleOrphanAtResend(g.gw as never, { ...row, heldBySentRow: true }, g.pause);
    expect(answer).toEqual({ kind: 'settled', outcome: 'superseded' });
    expect(g.calls).toEqual([]);
  });
});
