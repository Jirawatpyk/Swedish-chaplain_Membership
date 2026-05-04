/**
 * F8 Phase 3 Wave H2 · T058 spec — `cancelCycle` use-case.
 *
 * Target: 100% branch coverage (security-critical mutating path per
 * Constitution coverage table).
 *
 * runInTenant is stubbed via partial deps mock — the real
 * implementation wraps in a Drizzle tx; tests verify the use-case
 * invokes `transitionStatus` + `auditEmitter.emitInTx` regardless of
 * tx mechanics.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cancelCycle } from '@/modules/renewals/application/use-cases/cancel-cycle';
import {
  CycleTransitionConflictError,
  CycleNotFoundError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';

const VALID_UUID = '00000000-0000-0000-0000-0000000000c2';
const TENANT_ID = 'tenantA';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return {
    tenantId: TENANT_ID,
    cycleId: asCycleId(VALID_UUID),
    memberId: 'mem-1',
    status: 'awaiting_payment' as const,
    periodFrom: '2026-06-01T00:00:00Z',
    periodTo: '2027-06-01T00:00:00Z',
    expiresAt: '2027-06-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular' as const,
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB' as const,
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as RenewalCycle;
}

function fakeDeps(
  cycle: RenewalCycle | null,
  transitionImpl?: () => Promise<RenewalCycle>,
): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  acquireLockMock: ReturnType<typeof vi.fn>;
} {
  const emitMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(async () => {});
  const transitionMock = vi.fn(
    transitionImpl ?? (async () => ({ ...cycle!, status: 'cancelled' as const })),
  );
  const acquireLockMock = vi.fn(async () => {});
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findById: vi.fn(async () => cycle),
      findByIdInTx: vi.fn(async () => cycle),
      transitionStatus: transitionMock,
      acquireCycleLockInTx: acquireLockMock,
    } as unknown as RenewalsDeps['cyclesRepo'],
    auditEmitter: {
      emit: emitMock,
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, emitMock, emitInTxMock, transitionMock, acquireLockMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: VALID_UUID,
  reason: 'member leaving',
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('cancelCycle (T058) — happy path', () => {
  it('transitions to cancelled + emits audit', async () => {
    const cycle = buildCycle();
    const { deps, emitInTxMock, transitionMock } = fakeDeps(cycle);
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('cancelled');
      expect(r.value.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
    // Typed payload assertion (TY1) — locks the contract that
    // renewal_cycle_cancelled carries cycle_id + member_id + reason +
    // previous_status. Future regression that drops a field fails here.
    expect(emitInTxMock.mock.calls[0]![1]).toEqual({
      type: 'renewal_cycle_cancelled',
      payload: {
        cycle_id: cycle.cycleId,
        member_id: cycle.memberId,
        reason: baseInput.reason,
        previous_status: cycle.status,
      },
    });
  });

  // Round 3: failure-path coverage — if transition rejects mid-tx, the
  // audit emit MUST NOT fire. Without this guard a future refactor that
  // moves emitInTx ahead of the mutation, or wraps transitionStatus in
  // a swallowing try/catch, would silently break state↔audit atomicity
  // (Constitution Principle VIII).
  // Round 5 W-10 — reverse-direction state↔audit atomicity. If audit
  // emit fails inside the tx, the throw must propagate to the outer
  // runInTenant which rolls the state mutation back. Without this, a
  // future refactor that swallows emit errors would silently commit
  // the state change without an audit row — Constitution Principle
  // VIII violation.
  it('throws on emitInTx DB-fault so the outer tx rolls back (state↔audit atomicity reverse)', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock, emitInTxMock } = fakeDeps(cycle);
    emitInTxMock.mockRejectedValueOnce(new Error('audit_log: insert failed'));
    await expect(cancelCycle(deps, baseInput)).rejects.toThrow(
      /audit_log.*insert failed/,
    );
    // The transition fired (it ran before the audit); the test's
    // contract is that the OUTER runInTenant treats this as an
    // unresolved error so the surrounding tx rolls back. The mock-tx
    // doesn't actually persist anything — the assertion is that the
    // throw propagates rather than being caught and converted to a
    // success Result.
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit audit if transitionStatus rejects (state↔audit atomicity)', async () => {
    const cycle = buildCycle();
    const { deps, emitInTxMock, acquireLockMock } = fakeDeps(cycle, async () => {
      throw new Error('db: serialization failure');
    });
    await expect(cancelCycle(deps, baseInput)).rejects.toThrow(
      /serialization failure/,
    );
    expect(acquireLockMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('acquires advisory lock BEFORE transitioning (TOCTOU defence)', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock, acquireLockMock } = fakeDeps(cycle);
    await cancelCycle(deps, baseInput);
    expect(acquireLockMock).toHaveBeenCalledTimes(1);
    expect(acquireLockMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      cycle.cycleId,
    );
    // Lock MUST acquire before transition — concurrent admin races
    // depend on this ordering.
    expect(acquireLockMock.mock.invocationCallOrder[0]!).toBeLessThan(
      transitionMock.mock.invocationCallOrder[0]!,
    );
  });

  // Round 6 W-R5-5 — verify findByIdInTx receives the SAME tx handle
  // that acquireLockInTx received. A regression where the use-case
  // calls findById (without tx) instead would silently re-introduce
  // the TOCTOU window.
  it('post-lock re-read uses findByIdInTx with the lock-holding tx', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle);
    await cancelCycle(deps, baseInput);
    const acquireLockTx = (
      deps.cyclesRepo.acquireCycleLockInTx as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    const findByIdInTxCalls = (
      deps.cyclesRepo.findByIdInTx as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(findByIdInTxCalls).toHaveLength(1);
    expect(findByIdInTxCalls[0]?.[0]).toBe(acquireLockTx);
  });


  // Round 6 S-R5-3 / Round 8 W-R7-1 / Round 9 W-R8-1 — assert audit
  // payload `reason` has CRLF + ANSI + C0/C1 control bytes AND the
  // FULL Unicode separator + format class (Round 8 W-R7-4
  // consolidated regex) stripped. Round 9 W-R8-1 fixed the test gap
  // where the 2-pass→1-pass consolidation extended the regex but
  // the test only covered 4 codepoints — now asserts every
  // codepoint in the consolidated range.
  it('strips CRLF + ANSI + C0/C1 + full Unicode separator class from reason (W-R5-3 + W-R7-1 + W-R8-1)', async () => {
    const { deps, emitInTxMock } = fakeDeps(buildCycle());
    // Inject a REPRESENTATIVE codepoint from every range covered by
    //   C0/C1 controls (CR/LF/ESC/BEL/8-bit-CSI)
    //   U+00A0 NBSP, U+1680 OGHAM SPACE
    //   U+2000-U+200F (en/em/thin/hair/zero-width spaces + format)
    //   U+2028 LINE SEP, U+2029 PARAGRAPH SEP, U+202F NARROW NBSP
    //   U+205F MEDIUM MATH SPACE, U+3000 IDEOGRAPHIC SPACE,
    //   U+FEFF BOM
    await cancelCycle(deps, {
      ...baseInput,
      reason:
        'inj\r\n\x1b[31m\x9b\x07ction' +
        ' \u00a0nbsp\u1680ogham' +
        ' \u2003emsp\u2009thin\u200bzwsp\u200dzwj\u200elrm\u200frtm' +
        ' \u2028lsep\u2029psep\u202fnnbsp' +
        ' \u205fmsp\u3000ideo\ufeffbom',
    });
    const emittedReason = (
      emitInTxMock.mock.calls[0]?.[1] as {
        payload: { reason: string };
      }
    ).payload.reason;
    // Single-pass regex covers FULL class — assert no codepoint
    // from the consolidated range survives.
    expect(emittedReason).not.toMatch(
      /[\u0000-\u001f\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/,
    );
    // Visible word content preserved (sanity-check no over-strip).
    expect(emittedReason).toContain('inj');
    expect(emittedReason).toContain('ction');
    expect(emittedReason).toContain('nbsp');
    expect(emittedReason).toContain('ogham');
    expect(emittedReason).toContain('emsp');
    expect(emittedReason).toContain('zwsp');
    expect(emittedReason).toContain('zwj');
    expect(emittedReason).toContain('lrm');
    expect(emittedReason).toContain('lsep');
    expect(emittedReason).toContain('psep');
    expect(emittedReason).toContain('nnbsp');
    expect(emittedReason).toContain('msp');
    expect(emittedReason).toContain('ideo');
    expect(emittedReason).toContain('bom');
  });
});

describe('cancelCycle — error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns invalid_input on bad cycleId', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await cancelCycle(deps, { ...baseInput, cycleId: 'not-a-uuid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('returns invalid_input on empty reason', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await cancelCycle(deps, { ...baseInput, reason: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('returns invalid_input on >500-char reason', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await cancelCycle(deps, {
      ...baseInput,
      reason: 'x'.repeat(501),
    });
    expect(r.ok).toBe(false);
  });

  it('returns cycle_not_found + emits probe on missing cycle', async () => {
    const { deps, emitMock } = fakeDeps(null);
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'renewal_cross_tenant_probe' }),
      expect.any(Object),
    );
  });

  it('returns cycle_not_cancellable on terminal state', async () => {
    const { deps } = fakeDeps(buildCycle({ status: 'completed' }));
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('cycle_not_cancellable');
      if (r.error.kind === 'cycle_not_cancellable') {
        expect(r.error.currentStatus).toBe('completed');
      }
    }
  });

  it('maps CycleTransitionConflictError to cycle_not_cancellable', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => {
      throw new CycleTransitionConflictError(
        cycle.cycleId,
        cycle.status,
        'cancelled',
      );
    });
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('cycle_not_cancellable');
    }
  });

  it('maps CycleNotFoundError (RLS race) to cycle_not_found', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => {
      throw new CycleNotFoundError(cycle.cycleId);
    });
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
  });

  it('rethrows unexpected errors', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => {
      throw new Error('db connection lost');
    });
    await expect(cancelCycle(deps, baseInput)).rejects.toThrow(
      'db connection lost',
    );
  });
});
