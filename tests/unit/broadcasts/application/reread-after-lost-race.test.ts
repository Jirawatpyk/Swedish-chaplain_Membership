/**
 * Spec 139 review round 2 — the one locking re-read every lost-race path on
 * both dispatch legs shares (`_reread-after-lost-race.ts`). Each arm a caller
 * relies on, pinned on the helper itself:
 *
 *   - the read runs under the row lock, inside its own tx (it waits for an
 *     erasure cascade still deciding the row);
 *   - a read that throws decides nothing (`null`) and writes the caller's warn;
 *   - a row still the caller's (default: `approved`) is not a skip;
 *   - a row that left is a skip, logged at info, answering its status;
 *   - a vanished row is a skip only when the caller opts in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { rereadAfterLostRace } from '@/modules/broadcasts/application/use-cases/_reread-after-lost-race';

const TENANT = 'test-tenant' as never;
const BROADCAST = 'b-1' as never;
const OPTS = {
  logFields: { tenantId: 'test-tenant', broadcastId: 'b-1' },
  readFailedEvent: 'test.reread_failed',
  skipEvent: 'test.lost_race',
};

function makeRepo(read: () => Promise<unknown>) {
  const calls: string[] = [];
  let open = 0;
  return {
    calls,
    repo: {
      withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        open += 1;
        try {
          return await fn({});
        } finally {
          open -= 1;
        }
      }),
      lockForUpdate: vi.fn(async () => {
        calls.push(open > 0 ? 'lock:in-tx' : 'lock:no-tx');
        return null;
      }),
      findByIdInTx: vi.fn(async () => {
        calls.push(open > 0 ? 'read:in-tx' : 'read:no-tx');
        return read();
      }),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rereadAfterLostRace (spec 139)', () => {
  it('locks the row, then reads it, both inside one tx', async () => {
    const { repo, calls } = makeRepo(async () => ({ status: 'cancelled' }));
    await rereadAfterLostRace(repo as never, TENANT, BROADCAST, OPTS);
    expect(calls).toEqual(['lock:in-tx', 'read:in-tx']);
  });

  it('a row that left `approved` → a concurrent skip at info, answering the status read', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { repo } = makeRepo(async () => ({ status: 'cancelled' }));
    const out = await rereadAfterLostRace(repo as never, TENANT, BROADCAST, OPTS);
    expect(out).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'cancelled' });
    expect(infoSpy).toHaveBeenCalledWith({ ...OPTS.logFields, observedStatus: 'cancelled' }, 'test.lost_race');
  });

  it('a row still `approved` → not a skip (null), nothing logged at info', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { repo } = makeRepo(async () => ({ status: 'approved' }));
    expect(await rereadAfterLostRace(repo as never, TENANT, BROADCAST, OPTS)).toBeNull();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('a caller-defined `stillOurs` decides instead of the approved default', async () => {
    const { repo } = makeRepo(async () => ({ status: 'cancelled' }));
    const out = await rereadAfterLostRace(repo as never, TENANT, BROADCAST, { ...OPTS, stillOurs: () => true });
    expect(out).toBeNull();
  });

  it('the read throws → null (decides nothing) and the caller’s warn line with errKind', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { repo } = makeRepo(async () => {
      throw new TypeError('connection reset');
    });
    expect(await rereadAfterLostRace(repo as never, TENANT, BROADCAST, OPTS)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith({ ...OPTS.logFields, err: 'TypeError' }, 'test.reread_failed');
  });

  it('a vanished row is NOT a skip by default (the caller keeps its own path)', async () => {
    const { repo } = makeRepo(async () => null);
    expect(await rereadAfterLostRace(repo as never, TENANT, BROADCAST, OPTS)).toBeNull();
  });

  it('a vanished row IS a skip when the caller opts in, answering unknown_or_already_processed', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { repo } = makeRepo(async () => null);
    const out = await rereadAfterLostRace(repo as never, TENANT, BROADCAST, { ...OPTS, vanishedRowIsSkip: true });
    expect(out).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'unknown_or_already_processed' });
    expect(infoSpy).toHaveBeenCalledWith({ ...OPTS.logFields, observedStatus: null }, 'test.lost_race');
  });

  it('reportObservedStatus: unknown_or_already_processed masks the status read', async () => {
    const { repo } = makeRepo(async () => ({ status: 'sending' }));
    const out = await rereadAfterLostRace(repo as never, TENANT, BROADCAST, {
      ...OPTS,
      reportObservedStatus: 'unknown_or_already_processed',
    });
    expect(out).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'unknown_or_already_processed' });
  });
});
