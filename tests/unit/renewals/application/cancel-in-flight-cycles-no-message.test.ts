/**
 * #711 — the renewals erasure/archival cascade carries only an error's CLASS,
 * never its message: a Drizzle/Neon message can quote bound parameters (an
 * email, a company name) of the member being erased. The Result error, the
 * audit-emit outcome and every log line must hold no message text.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

const { logger } = await import('@/lib/logger');
const { cancelInFlightCyclesForMember } = await import(
  '@/modules/renewals/application/use-cases/cancel-in-flight-cycles-for-member'
);

const SECRET = 'duplicate key (email)=(jane.doe@example.com) params: Acme Co';
const INPUT = {
  tenant: { slug: 't-1' },
  memberId: 'm-1',
  cascadeReason: 'gdpr_erasure_request',
  initiatedByUserId: null,
  requestId: null,
  correlationId: 'c-1',
} as never;

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return JSON.stringify(spy.mock.calls);
}

describe('#711 cancelInFlightCyclesForMember — class only, no message', () => {
  it('a lookup throw returns { kind, errClass } and logs no message', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const deps = {
      cyclesRepo: {
        findActiveForMember: async () => {
          throw new TypeError(SECRET);
        },
      },
      clock: { now: () => new Date('2026-11-18T00:00:00Z') },
    } as never;
    const res = await cancelInFlightCyclesForMember(deps, INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ kind: 'cascade.server_error', errClass: 'TypeError' });
    expect(logged(spy)).not.toContain('jane.doe');
    spy.mockRestore();
  });

  it('an audit-emit failure returns no message and logs none', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const cycle = { cycleId: 'cy-1', status: 'awaiting_payment' };
    const deps = {
      cyclesRepo: {
        findActiveForMember: async () => cycle,
        acquireCycleLockInTx: async () => undefined,
        findByIdInTx: async () => cycle,
        transitionStatus: async () => undefined,
      },
      auditEmitter: {
        emitInTx: async () => {
          throw Object.assign(new Error(SECRET), { code: '22P02' });
        },
      },
      clock: { now: () => new Date('2026-11-18T00:00:00Z') },
    } as never;
    const res = await cancelInFlightCyclesForMember(deps, INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.outcome).toBe('cascade_audit_emit_failed');
      expect(JSON.stringify(res.value)).not.toContain('jane.doe');
    }
    expect(logged(spy)).not.toContain('jane.doe');
    spy.mockRestore();
  });

  it('a tx failure that is not an audit-emit logs no message', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const cycle = { cycleId: 'cy-1', status: 'awaiting_payment' };
    const deps = {
      cyclesRepo: {
        findActiveForMember: async () => cycle,
        acquireCycleLockInTx: async () => {
          throw new Error(SECRET);
        },
      },
      clock: { now: () => new Date('2026-11-18T00:00:00Z') },
    } as never;
    const res = await cancelInFlightCyclesForMember(deps, INPUT);
    expect(res.ok).toBe(true);
    expect(logged(spy)).not.toContain('jane.doe');
    spy.mockRestore();
  });
});
