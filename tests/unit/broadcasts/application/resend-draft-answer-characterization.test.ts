/**
 * Spec 140 s2d (#735) — the CHARACTERIZATION matrix of the five callers that
 * map Resend's answers about one draft (one bounded `deleteBroadcastOnce`,
 * then, on some answers, one bounded `retrieveBroadcastOnce`) to an outcome:
 *
 *   - `settleAtResend` — the erasure cascade's in-flight arm, under the row lock;
 *   - `settleTerminalDraft` — the erasure cascade's terminal-draft pass;
 *   - `deleteDraftBeforeErasedRefusal` (and `deleteDraftBeforeRefusal`, which it wraps);
 *   - `deleteDraftBeforeStandingRefusal` (`refusal: 'standing'` and `'terminal'`);
 *   - `settleOrphanAtResend` — the drain and the erasure orphan passes.
 *
 * Committed GREEN on the code BEFORE the classifier refactor: it is evidence
 * that the refactor changed nothing, not a RED. The tables differ ON PURPOSE
 * (plan.md § "Slice 2d — plan review", #735): a 404 clears at once on the
 * terminal arm but is confirmed on the orphan and in-flight arms, `(404, sent)`
 * is undecided for an orphan but `already_sent` + evidence in flight, and a 403
 * then `failed` is retained, cleared or unexpected depending on the arm.
 *
 * Each caller is driven through its PUBLIC surface (the in-flight and terminal
 * arms through `cancelInFlightBroadcastsForMember` in the erasure mode), with
 * a counting gateway double. Each cell asserts the caller's result, the count
 * it feeds (or the withholding), the evidence row, every log line (event name
 * and fields), the DELETE / GET / pause counts, and — for a `present` probe —
 * that its `sentAt` reaches no log line, no audit payload and no orphan
 * outcome (the standing refusal's `handed.sentAt` is its one carrier, today).
 *
 * The GET column has no `scheduled`: the gateway reads a real `scheduled` as
 * `unknown` (`RetrievedBroadcastResource['status']`), so `unknown` is that cell.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lines, cascadeOutcomeSpy } = vi.hoisted(() => ({
  lines: [] as Array<readonly [string, string, Record<string, unknown>]>,
  cascadeOutcomeSpy: vi.fn(),
}));
vi.mock('@/lib/logger', () => {
  const at = (level: string) => (fields: Record<string, unknown>, event: string) => {
    lines.push([level, event, fields]);
  };
  return { logger: { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') } };
});
vi.mock('@/lib/metrics', async () => {
  const actual = await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      cascadeOutcome: cascadeOutcomeSpy,
      auditEmitCount: vi.fn(),
      auditEmitFailed: vi.fn(),
    },
  };
});

import { cancelInFlightBroadcastsForMember } from '@/modules/broadcasts/application/use-cases/cancel-in-flight-broadcasts-for-member';
import {
  deleteDraftBeforeErasedRefusal,
  deleteDraftBeforeStandingRefusal,
} from '@/modules/broadcasts/application/use-cases/_dispatch-standing-gate';
import { settleOrphanAtResend } from '@/modules/broadcasts/application/use-cases/_settle-orphan-at-resend';
import { REPROBE_PAUSE_MS } from '@/modules/broadcasts/application/use-cases/_reprobe-pause';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';

/** What the DELETE answers; `throw` = a double that breaks the never-throws contract. */
type D = 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other' | 'throw';
/** What the GET answers; `null` in a cell = no GET is expected (the double still answers `not_found` and counts it). */
type G = 'not_found' | 'draft' | 'queued' | 'sending' | 'sent' | 'cancelled' | 'failed' | 'unknown' | 'retryable' | 'other' | 'throw';
type Handed = 'queued' | 'sending' | 'sent';

/** A distinctive `sent_at` on every `present` probe: it must never leak (docblock). */
const SENT_AT = '2026-05-03T00:00:09.999Z#sentinel';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const broadcastId = '22222222-2222-4222-8222-222222222222';

function gateway(d: D, g: G | null) {
  const counts = { delete: 0, get: 0, deleteAudience: 0 };
  const pauses: number[] = [];
  return {
    counts,
    pauses,
    pause: async (ms: number) => {
      pauses.push(ms);
    },
    gw: {
      deleteBroadcastOnce: async (_id: string) => {
        counts.delete += 1;
        if (d === 'throw') throw new Error('a fake that breaks the never-throws contract');
        return { kind: d };
      },
      retrieveBroadcastOnce: async (_id: string) => {
        counts.get += 1;
        const answer = g ?? 'not_found';
        if (answer === 'throw') throw new Error('a fake that breaks the never-throws contract');
        if (answer === 'not_found' || answer === 'retryable' || answer === 'other') return { kind: answer };
        return { kind: 'present' as const, status: answer, sentAt: SENT_AT };
      },
      deleteAudience: async (_id: string) => {
        counts.deleteAudience += 1;
      },
    },
  };
}

/** The reading a caller logs for a GET answer. */
const reading = (g: G): string => g;

beforeEach(() => {
  lines.length = 0;
  cascadeOutcomeSpy.mockReset();
});

// ---------------------------------------------------------------------------
// The erasure cascade: one harness for the in-flight and terminal arms.
// ---------------------------------------------------------------------------

interface CascadeRun {
  readonly result: Awaited<ReturnType<typeof cancelInFlightBroadcastsForMember>>;
  readonly emits: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }>;
  readonly counts: { delete: number; get: number; deleteAudience: number };
  readonly pauses: ReadonlyArray<number>;
}

async function runCascade(arm: 'in_flight' | 'terminal', d: D, g: G | null): Promise<CascadeRun> {
  const g$ = gateway(d, g);
  const emits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const evidence = new Set<string>();
  let cancelled = false;
  const broadcastsRepo = {
    listInFlightOwnedByMember: async () =>
      arm === 'in_flight' ? [{ broadcastId, tenantId: 'test-tenant', status: 'approved', resendBroadcastId: null, audienceImportId: null }] : [],
    // The in-flight arm: the row it has just cancelled still holds its Resend
    // id, so the terminal pass lists it and counts it from that settlement
    // (`settledAtResendThisRun`) with no second DELETE.
    listTerminalWithResendIdOwnedByMember: async () => {
      if (arm === 'terminal') return [{ broadcastId, status: 'failed_to_dispatch', resendBroadcastId: 'rb-1' }];
      return cancelled ? [{ broadcastId, status: 'cancelled', resendBroadcastId: 'rb-1' }] : [];
    },
    withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    lockForUpdate: async () => null,
    findByIdInTx: async () => ({ broadcastId, tenantId: 'test-tenant', status: 'approved', resendBroadcastId: 'rb-1', audienceImportId: null }),
    applyTransition: async () => {
      cancelled = true;
      return { broadcastId };
    },
    findById: async () => ({ broadcastId, status: 'sending' }),
    readAlreadySentEvidenceInTx: async (_tx: unknown, _t: unknown, q: { broadcastId: string | null }) => ({
      broadcastRecorded: q.broadcastId !== null && evidence.has(q.broadcastId),
      memberBroadcastCount: evidence.size,
    }),
  };
  const audit = {
    emit: async (_tx: unknown, event: { eventType: string; payload: Record<string, unknown> }) => {
      emits.push({ eventType: event.eventType, payload: event.payload });
      if (event.payload['resendOutcome'] === 'already_sent') evidence.add(String(event.payload['broadcastId']));
    },
  };
  const orphans = {
    listMemberOrphans: async () => [],
    listUnsettledAudienceOrphans: async () => [],
    settleOrphan: async () => true,
    markOrphanAttempted: async () => true,
  };
  const result = await cancelInFlightBroadcastsForMember(
    {
      broadcastsRepo,
      audit,
      clock: { now: () => new Date('2026-05-03T00:00:00Z') },
      broadcastsGateway: g$.gw,
      orphans,
      pauseBeforeReprobe: g$.pause,
    } as never,
    { tenant, memberId, requestId: 'req-1', onDispatchBegun: 'delete_then_cancel', cancellationReason: 'gdpr_erasure_request' },
  );
  return { result, emits, counts: g$.counts, pauses: g$.pauses };
}

const logBase = { tenantId: 'test-tenant', memberId: memberId as string, useCase: 'cancel-in-flight-broadcasts-for-member' };

/** The counts the cascade returns; every other field 0. */
function output(over: Partial<Record<'cancelledCount' | 'unexpectedErrorCount' | 'alreadySentCount' | 'resendDraftsCleared' | 'resendCopiesRetained', number>>) {
  return {
    cancelledCount: 0,
    skippedConcurrentCount: 0,
    unexpectedErrorCount: 0,
    alreadySentCount: 0,
    resendDraftsCleared: 0,
    resendCopiesRetained: 0,
    deferredCount: 0,
    audienceOrphansStuckCount: 0,
    ...over,
  };
}

function completedLine(out: ReturnType<typeof output>) {
  return [
    'info',
    'broadcasts.cascade.completed',
    {
      tenantId: 'test-tenant',
      memberId: memberId as string,
      ...out,
      onDispatchBegun: 'delete_then_cancel',
      cascade: 'f3_member_archival_or_erasure',
    },
  ] as const;
}

function evidencePayload(snapshotStatus: string, observedStatus: string, resendStatus: Handed) {
  return {
    broadcastId,
    memberId: memberId as string,
    cascade: 'f3_member_archival_or_erasure',
    snapshotStatus,
    observedStatus,
    dispatchBegun: true,
    resendOutcome: 'already_sent',
    observedResendStatus: resendStatus,
  };
}

function expectNoSentAt(...values: unknown[]): void {
  for (const v of values) expect(JSON.stringify(v)).not.toContain(SENT_AT);
}

// ---------------------------------------------------------------------------
// 1. settleAtResend — the in-flight arm (under the row lock)
// ---------------------------------------------------------------------------

type InFlightExp =
  | { readonly r: 'cancel'; readonly resendOutcome: 'deleted' | 'absent' | 'cancelled_at_resend'; readonly feeds: 'cleared' | 'retained' }
  | { readonly r: 'already_sent'; readonly status: Handed }
  /** `resendOutcome: null` = the raw throw propagated (no `resendOutcome` field on the line). */
  | { readonly r: 'unexpected'; readonly resendOutcome: string | null };

const cancel = (resendOutcome: 'deleted' | 'absent' | 'cancelled_at_resend', feeds: 'cleared' | 'retained'): InFlightExp => ({ r: 'cancel', resendOutcome, feeds });
const alreadySent = (status: Handed): InFlightExp => ({ r: 'already_sent', status });
const unexpected = (resendOutcome: string | null): InFlightExp => ({ r: 'unexpected', resendOutcome });

const IN_FLIGHT_CELLS: ReadonlyArray<readonly [D, G | null, InFlightExp]> = [
  ['deleted', null, cancel('deleted', 'cleared')],
  ['retryable', null, unexpected('retryable')],
  ['other', null, unexpected('other')],
  ['throw', null, unexpected(null)],
  ['absent', 'not_found', cancel('absent', 'cleared')],
  ['absent', 'draft', unexpected('absent_probe_draft')],
  ['absent', 'queued', alreadySent('queued')],
  ['absent', 'sending', alreadySent('sending')],
  ['absent', 'sent', alreadySent('sent')],
  ['absent', 'cancelled', unexpected('absent_probe_cancelled')],
  ['absent', 'failed', unexpected('absent_probe_failed')],
  ['absent', 'unknown', unexpected('absent_probe_unknown')],
  ['absent', 'retryable', unexpected('absent_probe_retryable')],
  ['absent', 'other', unexpected('absent_probe_other')],
  ['absent', 'throw', unexpected(null)],
  ['forbidden', 'not_found', unexpected('forbidden_probe_not_found')],
  ['forbidden', 'draft', unexpected('forbidden_probe_draft')],
  ['forbidden', 'queued', alreadySent('queued')],
  ['forbidden', 'sending', alreadySent('sending')],
  ['forbidden', 'sent', alreadySent('sent')],
  ['forbidden', 'cancelled', cancel('cancelled_at_resend', 'retained')],
  ['forbidden', 'failed', unexpected('forbidden_probe_failed')],
  ['forbidden', 'unknown', unexpected('forbidden_probe_unknown')],
  ['forbidden', 'retryable', unexpected('forbidden_probe_retryable')],
  ['forbidden', 'other', unexpected('forbidden_probe_other')],
  ['forbidden', 'throw', unexpected(null)],
];

describe('characterization — settleAtResend (in-flight arm, erasure mode)', () => {
  it.each(IN_FLIGHT_CELLS)('DELETE %s, GET %s', async (d, g, exp) => {
    const run = await runCascade('in_flight', d, g);
    const ids = { ...logBase, broadcastId, resendBroadcastId: 'rb-1' };

    // Gateway calls and the pause: a GET only after a 404 or a 403, the pause only after a 404.
    const probed = d === 'absent' || d === 'forbidden';
    expect(run.counts).toEqual({ delete: 1, get: probed ? 1 : 0, deleteAudience: 0 });
    expect(run.pauses).toEqual(d === 'absent' ? [REPROBE_PAUSE_MS] : []);

    // The `dispatch_begun_delete` line: written once the answers are in; none when the DELETE threw.
    // Spec 140 s2d (#736c, L1) — a GET that throws after a 404 / 403 still writes it, with
    // `probe: 'threw'` and both timings: the row lock was held for Resend all the same.
    const expected: Array<readonly [string, string, Record<string, unknown>]> = [];
    if (d === 'deleted') {
      expected.push(['info', 'broadcasts.cascade.dispatch_begun_delete', { ...ids, outcome: 'deleted', deleteMs: expect.any(Number) }]);
    } else if (probed) {
      expected.push([
        'info',
        'broadcasts.cascade.dispatch_begun_delete',
        { ...ids, outcome: d, probe: g === 'throw' ? 'threw' : reading(g!), resendMs: expect.any(Number), deleteMs: expect.any(Number) },
      ]);
    }

    let out: ReturnType<typeof output>;
    const cancelledPayloads = run.emits.filter((e) => e.eventType === 'broadcast_cancelled').map((e) => e.payload['resendOutcome']);
    const evidenceRows = run.emits.filter((e) => e.eventType === 'broadcast_concurrent_action_blocked').map((e) => e.payload);
    if (exp.r === 'cancel') {
      out = output({
        cancelledCount: 1,
        ...(exp.feeds === 'cleared' ? { resendDraftsCleared: 1 } : { resendCopiesRetained: 1 }),
      });
      expect(cancelledPayloads).toEqual([exp.resendOutcome]);
      expect(evidenceRows).toEqual([]);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual([
        'cancelled',
        exp.feeds === 'cleared' ? 'terminal_draft_cleared' : 'terminal_copy_retained',
      ]);
    } else if (exp.r === 'already_sent') {
      out = output({ alreadySentCount: 1 });
      expect(cancelledPayloads).toEqual([]);
      expect(evidenceRows).toEqual([evidencePayload('approved', 'approved', exp.status)]);
      expected.push([
        'warn',
        'broadcasts.cascade.dispatch_begun_already_sent',
        { ...logBase, broadcastId, observedStatus: 'approved', observedResendStatus: exp.status, evidenceExisted: false },
      ]);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['already_sent']);
    } else {
      out = output({ unexpectedErrorCount: 1 });
      expect(cancelledPayloads).toEqual([]);
      expect(evidenceRows).toEqual([]);
      expected.push([
        'error',
        'broadcasts.cascade.tx_or_audit_failed',
        {
          ...logBase,
          err: exp.resendOutcome === null ? 'Error' : 'ResendUnsettledError',
          broadcastId,
          previousStatus: 'approved',
          ...(exp.resendOutcome === null ? {} : { resendOutcome: exp.resendOutcome }),
        },
      ]);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error']);
    }
    expected.push(completedLine(out));

    expect(run.result).toEqual({ ok: true, value: out });
    expect(lines).toEqual(expected);
    expectNoSentAt(lines, run.emits, run.result);
  });
});

// ---------------------------------------------------------------------------
// 2. settleTerminalDraft — the terminal-draft pass (no lock, no row write)
// ---------------------------------------------------------------------------

type TerminalExp =
  | { readonly r: 'cleared' }
  | { readonly r: 'retained' }
  | { readonly r: 'handed'; readonly status: Handed }
  | { readonly r: 'unexpected'; readonly resendOutcome: string | null };

const t = {
  cleared: { r: 'cleared' } as TerminalExp,
  retained: { r: 'retained' } as TerminalExp,
  handed: (status: Handed): TerminalExp => ({ r: 'handed', status }),
  unexpected: (resendOutcome: string | null): TerminalExp => ({ r: 'unexpected', resendOutcome }),
};

const TERMINAL_CELLS: ReadonlyArray<readonly [D, G | null, TerminalExp]> = [
  ['deleted', null, t.cleared],
  // A 404 clears at once here (no pause, no GET), unlike the in-flight and orphan arms.
  ['absent', null, t.cleared],
  ['retryable', null, t.unexpected('retryable')],
  ['other', null, t.unexpected('other')],
  ['throw', null, t.unexpected(null)],
  ['forbidden', 'not_found', t.unexpected('forbidden_probe_not_found')],
  ['forbidden', 'draft', t.unexpected('forbidden_probe_draft')],
  ['forbidden', 'queued', t.handed('queued')],
  ['forbidden', 'sending', t.handed('sending')],
  ['forbidden', 'sent', t.handed('sent')],
  ['forbidden', 'cancelled', t.retained],
  ['forbidden', 'failed', t.retained],
  ['forbidden', 'unknown', t.unexpected('forbidden_probe_unknown')],
  ['forbidden', 'retryable', t.unexpected('forbidden_probe_retryable')],
  ['forbidden', 'other', t.unexpected('forbidden_probe_other')],
  ['forbidden', 'throw', t.unexpected(null)],
];

describe('characterization — settleTerminalDraft (terminal-draft pass, erasure mode)', () => {
  it.each(TERMINAL_CELLS)('DELETE %s, GET %s', async (d, g, exp) => {
    const run = await runCascade('terminal', d, g);
    const ids = { ...logBase, broadcastId, status: 'failed_to_dispatch', resendBroadcastId: 'rb-1' };

    expect(run.counts).toEqual({ delete: 1, get: d === 'forbidden' ? 1 : 0, deleteAudience: 0 });
    expect(run.pauses).toEqual([]);

    const expected: Array<readonly [string, string, Record<string, unknown>]> = [];
    if (d === 'deleted' || d === 'absent') {
      expected.push(['info', 'broadcasts.cascade.terminal_draft', { ...ids, outcome: d }]);
    } else if (d === 'forbidden' && g !== 'throw') {
      expected.push(['info', 'broadcasts.cascade.terminal_draft', { ...ids, outcome: 'forbidden', probe: reading(g!) }]);
    }

    let out: ReturnType<typeof output>;
    const evidenceRows = run.emits.filter((e) => e.eventType === 'broadcast_concurrent_action_blocked').map((e) => e.payload);
    expect(run.emits.filter((e) => e.eventType === 'broadcast_cancelled')).toEqual([]);
    if (exp.r === 'cleared') {
      out = output({ resendDraftsCleared: 1 });
      expect(evidenceRows).toEqual([]);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['terminal_draft_cleared']);
    } else if (exp.r === 'retained') {
      out = output({ resendCopiesRetained: 1 });
      expect(evidenceRows).toEqual([]);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['terminal_copy_retained']);
    } else if (exp.r === 'handed') {
      // `recordAlreadySent` — the in-flight arm's evidence row, once.
      out = output({ alreadySentCount: 1 });
      expect(evidenceRows).toEqual([evidencePayload('failed_to_dispatch', 'failed_to_dispatch', exp.status)]);
      expected.push([
        'warn',
        'broadcasts.cascade.dispatch_begun_already_sent',
        { ...logBase, broadcastId, observedStatus: 'failed_to_dispatch', observedResendStatus: exp.status, evidenceExisted: false },
      ]);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['already_sent']);
    } else {
      out = output({ unexpectedErrorCount: 1 });
      expect(evidenceRows).toEqual([]);
      expected.push([
        'error',
        'broadcasts.cascade.terminal_draft_unresolved',
        {
          ...logBase,
          err: exp.resendOutcome === null ? 'Error' : 'ResendUnsettledError',
          broadcastId,
          previousStatus: 'failed_to_dispatch',
          ...(exp.resendOutcome === null ? {} : { resendOutcome: exp.resendOutcome }),
        },
      ]);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error']);
    }
    expected.push(completedLine(out));

    expect(run.result).toEqual({ ok: true, value: out });
    expect(lines).toEqual(expected);
    expectNoSentAt(lines, run.emits, run.result);
  });
});

// ---------------------------------------------------------------------------
// 3. deleteDraftBeforeErasedRefusal (and deleteDraftBeforeRefusal) — no GET
// ---------------------------------------------------------------------------

type Prior = 'draft' | 'cancelled' | null;
const gateIds = { tenantId: 'test-tenant', broadcastId: 'b-1', leg: 'live' as const };

type ErasedExp =
  | { readonly r: 'cleared'; readonly draftOutcome: 'none' | 'deleted' | 'absent' | 'cancelled' }
  | { readonly r: 'undecided'; readonly errClass: 'forbidden' | 'retryable' | 'other' | 'threw' };

const ERASED_CELLS: ReadonlyArray<readonly [D, Prior, ErasedExp]> = [
  ['deleted', 'draft', { r: 'cleared', draftOutcome: 'deleted' }],
  ['deleted', 'cancelled', { r: 'cleared', draftOutcome: 'deleted' }],
  ['deleted', null, { r: 'cleared', draftOutcome: 'deleted' }],
  ['absent', 'draft', { r: 'cleared', draftOutcome: 'absent' }],
  ['absent', 'cancelled', { r: 'cleared', draftOutcome: 'absent' }],
  ['absent', null, { r: 'cleared', draftOutcome: 'absent' }],
  ['forbidden', 'draft', { r: 'undecided', errClass: 'forbidden' }],
  // The tick's earlier probe read `cancelled`: a 403 clears with no GET.
  ['forbidden', 'cancelled', { r: 'cleared', draftOutcome: 'cancelled' }],
  ['forbidden', null, { r: 'undecided', errClass: 'forbidden' }],
  ['retryable', 'draft', { r: 'undecided', errClass: 'retryable' }],
  ['retryable', 'cancelled', { r: 'undecided', errClass: 'retryable' }],
  ['retryable', null, { r: 'undecided', errClass: 'retryable' }],
  ['other', 'draft', { r: 'undecided', errClass: 'other' }],
  ['other', 'cancelled', { r: 'undecided', errClass: 'other' }],
  ['other', null, { r: 'undecided', errClass: 'other' }],
  ['throw', 'draft', { r: 'undecided', errClass: 'threw' }],
  ['throw', 'cancelled', { r: 'undecided', errClass: 'threw' }],
  ['throw', null, { r: 'undecided', errClass: 'threw' }],
];

describe('characterization — deleteDraftBeforeErasedRefusal (never a GET)', () => {
  it.each([
    ['no id on the row', null],
    ['an empty id', { resendBroadcastId: '', probedStatus: null }],
  ] as const)('%s → cleared (none), no Resend call, no line', async (_label, draft) => {
    const g$ = gateway('deleted', null);
    expect(await deleteDraftBeforeErasedRefusal(g$.gw, gateIds, draft)).toEqual({ kind: 'cleared', draftOutcome: 'none' });
    expect(g$.counts).toEqual({ delete: 0, get: 0, deleteAudience: 0 });
    expect(lines).toEqual([]);
  });

  it.each(ERASED_CELLS)('DELETE %s, priorProbe %s', async (d, prior, exp) => {
    const g$ = gateway(d, null);
    const result = await deleteDraftBeforeErasedRefusal(g$.gw, gateIds, { resendBroadcastId: 'rb-1', probedStatus: prior });
    const probedStatus = prior ?? 'not_found';
    const logIds = { ...gateIds, refusal: 'erased', resendBroadcastId: 'rb-1', probedStatus };

    expect(g$.counts).toEqual({ delete: 1, get: 0, deleteAudience: 0 });
    if (exp.r === 'cleared') {
      expect(result).toEqual({ kind: 'cleared', draftOutcome: exp.draftOutcome });
      expect(lines).toEqual([
        exp.draftOutcome === 'cancelled'
          ? ['info', 'broadcasts.dispatch.refused_draft_cancelled_unsendable', { ...logIds, outcome: 'forbidden' }]
          : ['info', 'broadcasts.dispatch.refused_draft_deleted', { ...logIds, outcome: d }],
      ]);
    } else {
      const errValue = exp.errClass === 'threw' ? 'Error' : null;
      expect(result).toEqual({ kind: 'undecided', errClass: exp.errClass, resendBroadcastId: 'rb-1', probedStatus, err: errValue });
      expect(lines).toEqual([
        [
          'warn',
          'broadcasts.dispatch.refused_draft_delete_unconfirmed',
          { ...logIds, outcome: exp.errClass, errClass: exp.errClass, err: errValue },
        ],
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. deleteDraftBeforeStandingRefusal — `refusal: 'standing'` and `'terminal'`
// ---------------------------------------------------------------------------

type StandingExp =
  | { readonly r: 'cleared'; readonly draftOutcome: 'deleted' | 'absent' | 'cancelled' | 'failed'; readonly via: 'delete' | 'get' }
  | { readonly r: 'handed'; readonly status: Handed }
  | { readonly r: 'undeleted'; readonly errClass: string; readonly observed: string | null; readonly outcome: string; readonly err: string | null };

const s = {
  clearedByDelete: (draftOutcome: 'deleted' | 'absent' | 'cancelled'): StandingExp => ({ r: 'cleared', draftOutcome, via: 'delete' }),
  clearedByGet: (draftOutcome: 'cancelled' | 'failed'): StandingExp => ({ r: 'cleared', draftOutcome, via: 'get' }),
  handed: (status: Handed): StandingExp => ({ r: 'handed', status }),
  undeleted: (errClass: string, observed: string | null, outcome: string, err: string | null = null): StandingExp => ({
    r: 'undeleted',
    errClass,
    observed,
    outcome,
    err,
  }),
};

/** The GET column after a 403 on an id the earlier probe did NOT call cancelled. */
const STANDING_GET: ReadonlyArray<readonly [G, StandingExp]> = [
  ['not_found', s.undeleted('probe_not_found', 'not_found', 'forbidden')],
  ['draft', s.undeleted('probe_draft', 'draft', 'forbidden')],
  ['queued', s.handed('queued')],
  ['sending', s.handed('sending')],
  ['sent', s.handed('sent')],
  ['cancelled', s.clearedByGet('cancelled')],
  ['failed', s.clearedByGet('failed')],
  ['unknown', s.undeleted('probe_other', 'unknown', 'forbidden')],
  ['retryable', s.undeleted('probe_retryable', 'retryable', 'forbidden')],
  ['other', s.undeleted('probe_other', 'other', 'forbidden')],
  ['throw', s.undeleted('threw', null, 'forbidden', 'Error')],
];

const STANDING_CELLS: ReadonlyArray<readonly ['standing' | 'terminal', D, Prior, G | null, StandingExp]> = [
  ...(['draft', 'cancelled', null] as const).flatMap((prior) => [
    ['standing', 'deleted', prior, null, s.clearedByDelete('deleted')] as const,
    ['standing', 'absent', prior, null, s.clearedByDelete('absent')] as const,
    ['standing', 'retryable', prior, null, s.undeleted('retryable', null, 'retryable')] as const,
    ['standing', 'other', prior, null, s.undeleted('other', null, 'other')] as const,
    ['standing', 'throw', prior, null, s.undeleted('threw', null, 'threw', 'Error')] as const,
  ]),
  // priorProbe `cancelled`: a 403 clears with NO GET.
  ['standing', 'forbidden', 'cancelled', null, s.clearedByDelete('cancelled')],
  ...(['draft', null] as const).flatMap((prior) =>
    STANDING_GET.map(([g, exp]) => ['standing', 'forbidden', prior, g, exp] as const),
  ),
  // The import leg's `failTerminally` choke point: only the `refusal` log field differs.
  ['terminal', 'deleted', 'draft', null, s.clearedByDelete('deleted')],
  ['terminal', 'retryable', 'draft', null, s.undeleted('retryable', null, 'retryable')],
  ['terminal', 'forbidden', 'cancelled', null, s.clearedByDelete('cancelled')],
  ['terminal', 'forbidden', 'draft', 'sent', s.handed('sent')],
  ['terminal', 'forbidden', 'draft', 'failed', s.clearedByGet('failed')],
  ['terminal', 'forbidden', 'draft', 'draft', s.undeleted('probe_draft', 'draft', 'forbidden')],
];

describe('characterization — deleteDraftBeforeStandingRefusal', () => {
  it.each([
    ['no id on the row', null],
    ['an empty id', { resendBroadcastId: '', probedStatus: null }],
  ] as const)('%s → cleared (none), no Resend call, no line', async (_label, draft) => {
    const g$ = gateway('deleted', null);
    expect(await deleteDraftBeforeStandingRefusal(g$.gw, gateIds, draft)).toEqual({ kind: 'cleared', draftOutcome: 'none' });
    expect(g$.counts).toEqual({ delete: 0, get: 0, deleteAudience: 0 });
    expect(lines).toEqual([]);
  });

  it.each(STANDING_CELLS)('refusal %s: DELETE %s, priorProbe %s, GET %s', async (refusal, d, prior, g, exp) => {
    const g$ = gateway(d, g);
    const draft = { resendBroadcastId: 'rb-1', probedStatus: prior };
    const result =
      refusal === 'standing'
        ? await deleteDraftBeforeStandingRefusal(g$.gw, gateIds, draft)
        : await deleteDraftBeforeStandingRefusal(g$.gw, gateIds, draft, 'terminal');
    const probedStatus = prior ?? 'not_found';
    const base = { ...gateIds, refusal, resendBroadcastId: 'rb-1', probedStatus };

    expect(g$.counts).toEqual({ delete: 1, get: g === null ? 0 : 1, deleteAudience: 0 });
    if (exp.r === 'cleared') {
      expect(result).toEqual({ kind: 'cleared', draftOutcome: exp.draftOutcome });
      if (exp.via === 'get') {
        expect(lines).toEqual([
          ['info', 'broadcasts.dispatch.refused_draft_cancelled_unsendable', { ...base, outcome: 'forbidden', observedResendStatus: exp.draftOutcome }],
        ]);
      } else if (exp.draftOutcome === 'cancelled') {
        expect(lines).toEqual([['info', 'broadcasts.dispatch.refused_draft_cancelled_unsendable', { ...base, outcome: 'forbidden' }]]);
      } else {
        expect(lines).toEqual([['info', 'broadcasts.dispatch.refused_draft_deleted', { ...base, outcome: d }]]);
      }
    } else if (exp.r === 'handed') {
      // Today's one carrier of `sent_at`: the result, never the line.
      expect(result).toEqual({ kind: 'handed', resendStatus: exp.status, sentAt: SENT_AT });
      expect(lines).toEqual([
        ['warn', 'broadcasts.dispatch.refused_draft_handed_by_sibling', { ...base, outcome: 'forbidden', observedResendStatus: exp.status }],
      ]);
    } else {
      expect(result).toEqual({ kind: 'undeleted', errClass: exp.errClass });
      const fields: Record<string, unknown> = { ...base, outcome: exp.outcome, observedResendStatus: exp.observed, errClass: exp.errClass };
      // Spec 140 s2d (#736c, L2) — one shape: `err` is always there, null when nothing threw.
      fields['err'] = exp.err;
      expect(lines).toEqual([['warn', 'broadcasts.dispatch.refused_draft_delete_unconfirmed', fields]]);
    }
    expectNoSentAt(lines);
  });
});

// ---------------------------------------------------------------------------
// 5. settleOrphanAtResend — the drain and the erasure orphan passes
// ---------------------------------------------------------------------------

type OrphanExp = { readonly kind: 'settled'; readonly outcome: string } | { readonly kind: 'undecided'; readonly answer: string };
const settled = (outcome: string): OrphanExp => ({ kind: 'settled', outcome });
const undecided = (answer: string): OrphanExp => ({ kind: 'undecided', answer });

const ORPHAN_CELLS: ReadonlyArray<readonly [D, G | null, OrphanExp]> = [
  ['deleted', null, settled('deleted')],
  ['retryable', null, undecided('retryable')],
  ['other', null, undecided('other')],
  ['throw', null, undecided('threw_unknown')],
  // A 404 is confirmed: pause, then a GET that must say not_found too.
  ['absent', 'not_found', settled('absent')],
  ['absent', 'draft', undecided('absent_probe_draft')],
  ['absent', 'queued', undecided('absent_probe_queued')],
  ['absent', 'sending', undecided('absent_probe_sending')],
  ['absent', 'sent', undecided('absent_probe_sent')],
  ['absent', 'cancelled', undecided('absent_probe_cancelled')],
  ['absent', 'failed', undecided('absent_probe_failed')],
  ['absent', 'unknown', undecided('absent_probe_unknown')],
  ['absent', 'retryable', undecided('absent_probe_retryable')],
  ['absent', 'other', undecided('absent_probe_other')],
  ['absent', 'throw', undecided('threw_unknown')],
  ['forbidden', 'not_found', undecided('forbidden_probe_not_found')],
  ['forbidden', 'draft', undecided('forbidden_probe_draft')],
  ['forbidden', 'queued', settled('handed')],
  ['forbidden', 'sending', settled('handed')],
  ['forbidden', 'sent', settled('handed')],
  ['forbidden', 'cancelled', settled('retained')],
  ['forbidden', 'failed', settled('retained')],
  ['forbidden', 'unknown', undecided('forbidden_probe_unknown')],
  ['forbidden', 'retryable', undecided('forbidden_probe_retryable')],
  ['forbidden', 'other', undecided('forbidden_probe_other')],
  ['forbidden', 'throw', undecided('threw_unknown')],
];

describe('characterization — settleOrphanAtResend', () => {
  const orphan = { resourceType: 'broadcast' as const, resourceId: 'rb-1', heldBySentRow: false };

  it.each(ORPHAN_CELLS)('DELETE %s, GET %s', async (d, g, exp) => {
    const g$ = gateway(d, g);
    const answer = await settleOrphanAtResend(g$.gw, orphan, g$.pause);
    expect(answer).toEqual(exp);
    expect(g$.counts).toEqual({ delete: 1, get: d === 'absent' || d === 'forbidden' ? 1 : 0, deleteAudience: 0 });
    expect(g$.pauses).toEqual(d === 'absent' ? [REPROBE_PAUSE_MS] : []);
    expect(lines).toEqual([]);
    expectNoSentAt(answer);
  });

  // Outside the classifier: decided before any broadcast call.
  it('a broadcast orphan a sent row holds → superseded, no Resend call', async () => {
    const g$ = gateway('forbidden', 'sent');
    expect(await settleOrphanAtResend(g$.gw, { ...orphan, heldBySentRow: true }, g$.pause)).toEqual(settled('superseded'));
    expect(g$.counts).toEqual({ delete: 0, get: 0, deleteAudience: 0 });
    expect(g$.pauses).toEqual([]);
  });

  it('an audience orphan → deleteAudience only, deleted', async () => {
    const g$ = gateway('forbidden', 'sent');
    expect(await settleOrphanAtResend(g$.gw, { resourceType: 'audience', resourceId: 'aud-1', heldBySentRow: false }, g$.pause)).toEqual(
      settled('deleted'),
    );
    expect(g$.counts).toEqual({ delete: 0, get: 0, deleteAudience: 1 });
  });
});
