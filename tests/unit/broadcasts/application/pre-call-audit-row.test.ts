/**
 * Spec 142 (AO4) — `writePreCallAuditRow`, the one envelope for an audit row
 * written before an irreversible Resend call: written (counted), a caller's
 * no-row answer (not counted), an adapter invariant error (the caller's hook,
 * then rethrown, never counted as lost), and a lost row (the caller's hook,
 * counted, answered `'lost'` so the call goes ahead).
 *
 * The callers' own cells pin their log lines through it. The audience rows:
 * `build-audience-tick-audience-audit.test.ts`, `cleanup-orphaned-audiences.test.ts`
 * and `reclaim-orphaned-audiences.test.ts`. The unverifiable-count row, in
 * `build-audience-tick-failure-paths.test.ts`: "a lost unverifiable row …"
 * pins its ERROR `broadcasts.audience_import.unverifiable_audit_emit_failed`
 * and the failed-emit counter, and "(d) an AuditPortInvariantError on the
 * unverifiable row …" pins that the invariant arm logs no ERROR.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { broadcastsMetrics } from '@/lib/metrics';
import { AuditPortInvariantError } from '@/modules/broadcasts/application/ports/audit-port';
import { writePreCallAuditRow } from '@/modules/broadcasts/application/use-cases/_pre-call-audit-row';
import { asTenantContext } from '@/modules/tenants';

const tenant = asTenantContext('test-tenant');
const EVENT = 'broadcast_audience_deleted' as const;

function harness() {
  const txs: unknown[] = [];
  const deps = {
    tenant,
    broadcastsRepo: {
      async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        const tx = { id: txs.length };
        txs.push(tx);
        return fn(tx);
      },
    },
  };
  const hooks = { onInvariant: vi.fn(), onLost: vi.fn() };
  return { deps, hooks, txs };
}

afterEach(() => vi.restoreAllMocks());

describe('writePreCallAuditRow', () => {
  it("written: runs `write` in its own tx and counts the row", async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness();
    const seen: unknown[] = [];
    const r = await writePreCallAuditRow(h.deps, EVENT, async (tx) => {
      seen.push(tx);
      return 'written';
    }, h.hooks);
    expect(r).toBe('written');
    expect(seen).toEqual(h.txs);
    expect(h.txs).toHaveLength(1);
    expect(counted).toHaveBeenCalledWith('test-tenant', EVENT);
    expect(failed).not.toHaveBeenCalled();
    expect(h.hooks.onInvariant).not.toHaveBeenCalled();
    expect(h.hooks.onLost).not.toHaveBeenCalled();
  });

  it("the caller's no-row answer is passed through and not counted", async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness();
    expect(await writePreCallAuditRow(h.deps, EVENT, async () => 'skip' as const, h.hooks)).toBe('skip');
    expect(counted).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('an adapter invariant error: onInvariant, then rethrown; never onLost, never counted as lost', async () => {
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness();
    const e = new AuditPortInvariantError(EVENT, 'wiring bug');
    await expect(
      writePreCallAuditRow(h.deps, EVENT, async () => {
        throw e;
      }, h.hooks),
    ).rejects.toBe(e);
    expect(h.hooks.onInvariant).toHaveBeenCalledWith(e);
    expect(h.hooks.onLost).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("a lost row: onLost, counted, answered 'lost' (the caller makes the call)", async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness();
    const e = Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('x'), { code: '57014' }) });
    const r = await writePreCallAuditRow(h.deps, EVENT, async () => {
      throw e;
    }, h.hooks);
    expect(r).toBe('lost');
    expect(h.hooks.onLost).toHaveBeenCalledWith(e);
    expect(h.hooks.onInvariant).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(EVENT, 'test-tenant');
    expect(counted).not.toHaveBeenCalled();
  });
});
