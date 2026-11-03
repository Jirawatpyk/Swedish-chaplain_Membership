/**
 * Spec 140 s2c (DL6) — the shared pre-send persist (`persistBroadcastIdBeforeSend`,
 * both legs) records an orphan row exactly when a minted id is left on no row:
 *
 *   - a reclaim that LEAKED (`attach_lost` / `row_vanished` / `persist_failed`)
 *     writes a row with the minted id and the requester; a reclaim that
 *     worked writes none (`_reclaim-minted-broadcast.ts` now answers
 *     `'reclaimed' | 'leaked'`);
 *   - a DB fault whose read-back failed keeps the id → `read_back_failed_kept`;
 *   - an INHERITED id (`minted: false`) is never this tick's to record;
 *   - a failed orphan insert is a critical log line and never changes the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { persistBroadcastIdBeforeSend } from '@/modules/broadcasts/application/use-cases/_persist-minted-broadcast-id';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { RecordOrphanInput } from '@/modules/broadcasts/application/ports/broadcast-orphans-repo';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('55555555-5555-4555-8555-555555555555');
const MEMBER = 'mmmmmmmm-0000-4000-8000-000000000001';

interface Opts {
  readonly attach?: 'ok' | 'cas_lost' | 'not_found' | 'db_fault';
  readonly reclaim?: 'ok' | 'throws';
  readonly readBack?: 'absent' | 'landed' | 'throws';
  readonly recordThrows?: boolean;
}

function harness(opts: Opts) {
  const recorded: RecordOrphanInput[] = [];
  const deletes: string[] = [];
  const deps = {
    tenant,
    broadcastsRepo: {
      async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(null);
      },
      async attachBroadcastId() {
        const a = opts.attach ?? 'ok';
        if (a === 'cas_lost') {
          throw new (BroadcastConcurrentMutationError as unknown as new (...x: unknown[]) => Error)(tenant.slug, BROADCAST_ID, 'cancelled');
        }
        if (a === 'not_found') throw new (BroadcastNotFoundError as unknown as new (...x: unknown[]) => Error)(tenant.slug, BROADCAST_ID);
        if (a === 'db_fault') throw new Error('08006 connection failure');
      },
      async findById() {
        if (opts.readBack === 'throws') throw new Error('57P01 terminating connection');
        return { resendBroadcastId: opts.readBack === 'landed' ? 'rb-minted' : null };
      },
    },
    broadcastsGateway: {
      async deleteBroadcast(id: string) {
        deletes.push(id);
        if (opts.reclaim === 'throws') throw { kind: 'retryable', subKind: 'timeout', reason: 'aborted' };
      },
    },
    orphans: {
      async recordOrphanedResendId(input: RecordOrphanInput) {
        if (opts.recordThrows === true) throw new Error('08006 connection failure');
        recorded.push(input);
      },
    },
  };
  const run = (minted = true) =>
    persistBroadcastIdBeforeSend(deps as never, { broadcastId: BROADCAST_ID }, {
      resendBroadcastId: 'rb-minted',
      resendAudienceId: 'aud-1',
      minted,
      lease: null,
      requestedByMemberId: MEMBER,
      logPrefix: 'broadcasts.dispatch',
    });
  return { run, recorded, deletes };
}

let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

const leaked = (reason: string): RecordOrphanInput => ({
  broadcastId: BROADCAST_ID,
  requestedByMemberId: MEMBER,
  resourceType: 'broadcast',
  resourceId: 'rb-minted',
  reason: reason as RecordOrphanInput['reason'],
});

describe('spec 140 s2c — the persist helper records a leaked minted id', () => {
  it.each([
    ['cas_lost', 'attach_lost'],
    ['not_found', 'row_vanished'],
  ] as const)('%s + a reclaim that LEAKED → one %s row with the minted id and the requester', async (attach, reason) => {
    const h = harness({ attach, reclaim: 'throws' });
    await h.run();
    expect(h.deletes).toEqual(['rb-minted']);
    expect(h.recorded).toEqual([leaked(reason)]);
  });

  it.each(['cas_lost', 'not_found'] as const)('%s + a reclaim that WORKED → no row', async (attach) => {
    const h = harness({ attach, reclaim: 'ok' });
    await h.run();
    expect(h.deletes).toEqual(['rb-minted']);
    expect(h.recorded).toEqual([]);
  });

  it('a DB fault, the read-back finds no id, the reclaim leaks → persist_failed', async () => {
    const h = harness({ attach: 'db_fault', readBack: 'absent', reclaim: 'throws' });
    const res = await h.run();
    expect(res).toMatchObject({ kind: 'dispatch.server_error', phase: 'persist_broadcast_id' });
    expect(h.recorded).toEqual([leaked('persist_failed')]);
  });

  it('a DB fault whose read-back FAILED keeps the id → read_back_failed_kept, and nothing is deleted', async () => {
    const h = harness({ attach: 'db_fault', readBack: 'throws' });
    await h.run();
    expect(h.deletes).toEqual([]);
    expect(h.recorded).toEqual([leaked('read_back_failed_kept')]);
  });

  it('a DB fault whose read-back finds the id landed → no row (the next tick inherits it)', async () => {
    const h = harness({ attach: 'db_fault', readBack: 'landed' });
    await h.run();
    expect(h.recorded).toEqual([]);
  });

  it('an inherited id (minted: false) never records, whatever the refusal', async () => {
    for (const attach of ['cas_lost', 'not_found', 'db_fault'] as const) {
      const h = harness({ attach, reclaim: 'throws', readBack: 'throws' });
      await h.run(false);
      expect(h.recorded, attach).toEqual([]);
    }
  });

  it('a failed orphan insert logs orphan_record_failed at critical (no `reason` key) and the answer is unchanged', async () => {
    const h = harness({ attach: 'cas_lost', reclaim: 'throws', recordThrows: true });
    const res = await h.run();
    expect(res).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'cancelled' });
    const line = error.mock.calls.find((c) => c[1] === 'broadcasts.dispatch.orphan_record_failed');
    expect(line?.[0]).toMatchObject({
      tenantId: tenant.slug,
      broadcastId: BROADCAST_ID,
      resourceType: 'broadcast',
      resourceId: 'rb-minted',
      orphanReason: 'attach_lost',
      severity: 'critical',
    });
    expect(line?.[0]).not.toHaveProperty('reason');
  });
});
