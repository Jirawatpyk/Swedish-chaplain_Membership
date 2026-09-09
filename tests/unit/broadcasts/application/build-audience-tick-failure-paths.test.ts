/**
 * 108 Phase 9 review round 1 — the failure surface of `buildAudienceTick`.
 *
 * `build-audience-tick.test.ts` next door covers the completion rule. This file
 * covers what happens when something goes wrong, because the review found that
 * `buildAudienceTick` had been written as a clean sibling of
 * `dispatchScheduledBroadcast` and had dropped four things the older path
 * accumulated over five review rounds: the terminal transition on a resolver
 * refusal, the FR-021 member notification, the `failureReason` write, and any
 * `catch` at all around the gateway.
 *
 * `tsc` cannot see a missing `applyTransition`, and a test that asserts only
 * `error.kind` cannot either. Six reviewers found this from six different
 * symptoms; the number that summarises it is that the new file had **0** catch
 * blocks against the legacy path's **18**.
 *
 * Every case here therefore asserts the STATE and the TRAIL, not just the
 * returned error:
 *
 *   - which status the row ended in (a row left `approved` is re-polled by the
 *     cron every 5 minutes for ever, and the bucket it increments means "done",
 *     so nothing alarms);
 *   - that an audit row was written, and which event type;
 *   - that `failureReason` is persisted, because the FR-021 email renders it;
 *   - that the member was told.
 *
 * Refs: reviews/review-20260908-223000.md S4, S5, S6, S7, S10, S12, S45, S47,
 *       S49, S55, S56
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { broadcastsMetrics } from '@/lib/metrics';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('44444444-4444-4444-8444-444444444444');
const NOW = new Date('2026-09-08T12:00:00Z');
const RECIPIENTS = ['a@example.com', 'b@example.com', 'c@example.com'];

/** A thrown gateway error, in the shape the Infrastructure adapter throws. */
function gatewayThrow(
  kind: string,
  reason = 'boom',
  extra: { resourceType?: 'audience' | 'broadcast'; resourceId?: string } = {},
): Error {
  const e = new Error(reason) as Error & {
    kind: string;
    reason: string;
    resourceType?: string;
    resourceId?: string;
  };
  e.kind = kind;
  e.reason = reason;
  // `resource_missing` carries these two — the adapter sets them, and the
  // Application layer reads the throw structurally (Principle III). A fixture
  // that omitted them would exercise a differently-shaped error than production
  // throws.
  if (extra.resourceType !== undefined) e.resourceType = extra.resourceType;
  if (extra.resourceId !== undefined) e.resourceId = extra.resourceId;
  return e;
}

type GatewayMethod =
  | 'createAudience'
  | 'createContactImport'
  | 'getContactImport'
  | 'createBroadcast'
  | 'sendBroadcast';

interface Recorder {
  readonly transitions: Array<{
    status: string;
    failureReason?: string | undefined;
    estimatedRecipientCount?: number | undefined;
    /** Which transaction wrote it — see finding 3-8. */
    txId?: number | undefined;
  }>;
  readonly audits: Array<{
    eventType: string;
    payload: Record<string, unknown>;
    txId?: number | undefined;
  }>;
  readonly memberEmails: Array<{ templateKey: string; reason: unknown }>;
  readonly sends: string[];
  readonly importsSubmitted: string[];
  readonly plansChecked: string[];
}

function makeDeps(opts: {
  readonly audienceImportId?: string | null;
  readonly audienceImportSubmittedAt?: Date | null;
  readonly resendAudienceId?: string | null;
  readonly importStatus?: string;
  readonly counts?: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  readonly resolveFails?: 'too_large' | 'empty' | 'malformed_segment' | 'server_error';
  readonly throwOn?: { readonly method: GatewayMethod; readonly kind: string };
  readonly droppedByPreference?: number;
  readonly orphans?: readonly string[];
  readonly memberPrimaryEmail?: string | null;
  /**
   * Round 2 R2-1 / round 3 finding 3-13 — make one of the two compare-and-set
   * writes lose its race. `concurrent` and `not_found` are the two typed errors
   * the repo throws after probing the row; `other` is anything else, which must
   * NOT be swallowed into a benign bucket.
   */
  readonly casThrowOn?: 'attachAudienceId' | 'attachAudienceImport';
  readonly casThrow?: 'concurrent' | 'not_found' | 'other';
  /** Round 3 finding 3-15 — make the TERMINAL write itself fail. */
  readonly transitionThrowsOn?: 'failed_to_dispatch' | 'sending';
  /** Round 3 finding 3-8 — make the audit INSERT itself fail. */
  readonly auditThrowsOn?: 'broadcast_send_started' | 'broadcast_failed_to_dispatch';
}): { deps: unknown; rec: Recorder } {
  let txSeq = 0;
  const rec: Recorder = {
    transitions: [],
    audits: [],
    memberEmails: [],
    sends: [],
    importsSubmitted: [],
    plansChecked: [],
  };

  const broadcast = {
    broadcastId: BROADCAST_ID,
    tenantId: tenant.slug,
    status: 'approved' as const,
    subject: 'Hello',
    bodyHtml: '<p>hi</p>',
    fromName: 'SweCham',
    replyToEmail: 'reply@example.com',
    requestedByMemberId: 'm-1',
    requestedByMemberPlanIdSnapshot: 'plan-old',
    scheduledFor: NOW,
    segmentType: 'all_members' as const,
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: RECIPIENTS.length,
    resendAudienceId: opts.resendAudienceId ?? null,
    audienceImportId: opts.audienceImportId ?? null,
    audienceImportSubmittedAt: opts.audienceImportSubmittedAt ?? null,
    audienceImportCompletedAt: null,
  };

  function maybeThrow(m: GatewayMethod): void {
    if (opts.throwOn?.method === m) {
      throw gatewayThrow(
        opts.throwOn.kind,
        'boom',
        opts.throwOn.kind === 'resource_missing'
          ? { resourceType: 'broadcast', resourceId: 'rb-gone' }
          : {},
      );
    }
  }

  function maybeCasThrow(m: 'attachAudienceId' | 'attachAudienceImport'): void {
    if (opts.casThrowOn !== m) return;
    if (opts.casThrow === 'not_found') {
      throw new BroadcastNotFoundError(tenant.slug, BROADCAST_ID);
    }
    if (opts.casThrow === 'other') {
      // A serialization failure or statement timeout. Not a lost race.
      throw new Error('40001 could not serialize access');
    }
    throw new BroadcastConcurrentMutationError(tenant.slug, BROADCAST_ID, 'sending');
  }

  function resolverAnswer() {
    if (opts.resolveFails === 'too_large') {
      return err({ kind: 'broadcast_audience_too_large' as const, count: 99_999, cap: 5_000 });
    }
    if (opts.resolveFails === 'empty') {
      // Round 3 finding 3-2 — the kind the RESOLVER actually returns
      // (`resolve-segment-recipients.ts:422`). This stub said
      // `broadcast_audience_post_suppression_empty`, which only
      // `dispatchScheduledBroadcast` produces, as its OUTPUT. So every "empty
      // audience" case in this file exercised dead code and passed green while
      // the real kind fell through to `dispatch.server_error`.
      return err({
        kind: 'broadcast_empty_segment_blocked' as const,
        droppedByPreference: 0,
        orphans: [],
      });
    }
    if (opts.resolveFails === 'malformed_segment') {
      return err({ kind: 'malformed_segment' as const });
    }
    if (opts.resolveFails === 'server_error') {
      return err({ kind: 'resolve.server_error' as const });
    }
    return ok({
      recipients: RECIPIENTS,
      estimatedCount: RECIPIENTS.length,
      orphans: opts.orphans ?? [],
      droppedByPreference: opts.droppedByPreference ?? 0,
    });
  }

  return {
    rec,
    deps: {
      tenant,
      clock: { now: () => NOW },
      fromEmail: 'noreply@example.com',
      tenantDisplayName: 'Test Chamber',
      locale: 'en' as const,
      resolveRecipients: async () => resolverAnswer(),
      membersBridge: {
        async getMemberPrimaryContact() {
          return opts.memberPrimaryEmail === undefined
            ? 'member@example.com'
            : opts.memberPrimaryEmail;
        },
        async getMemberPreferredLocale() {
          return 'en' as const;
        },
      },
      emailTransactional: {
        async sendMemberEmail(
          _t: unknown,
          m: { templateKey: string; payload: { reason?: unknown } },
        ) {
          rec.memberEmails.push({ templateKey: m.templateKey, reason: m.payload.reason });
        },
      },
      plansBridge: {
        // The real port name — `getPlanForMember`, returning a Result. The first
        // draft of this harness invented `getMemberCurrentPlanId`, and the test
        // failed for that reason rather than the one it was written to catch.
        // A stub whose method the production code never calls is a silent pass
        // waiting to happen; here it was a loud fail, which is the good case.
        async getPlanForMember(_t: unknown, memberId: string) {
          rec.plansChecked.push(memberId);
          // `plan-new` differs from the row's `requestedByMemberPlanIdSnapshot`
          // (`plan-old`), which is the AS5 condition.
          return ok({ planId: 'plan-new' });
        },
      },
      broadcastsRepo: {
        async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
          // A DISTINCT handle per transaction. `null` for every call made the
          // one property round 3 finding 3-8 turns on — which writes share a
          // transaction — unobservable in this harness, and a unit harness
          // cannot reproduce Postgres 25P02 abort semantics any other way.
          txSeq += 1;
          return fn({ txId: txSeq });
        },
        async lockForUpdate() {
          return 'approved';
        },
        async findByIdInTx() {
          return broadcast;
        },
        async attachAudienceId() {
          maybeCasThrow('attachAudienceId');
        },
        async attachAudienceImport(_tx: unknown, _t: unknown, _b: unknown, id: string) {
          maybeCasThrow('attachAudienceImport');
          rec.importsSubmitted.push(id);
        },
        async markAudienceImportCompleted() {
          /* no-op */
        },
        async attachResendIds() {
          /* no-op */
        },
        async applyTransition(
          tx: unknown,
          _t: unknown,
          _b: unknown,
          status: string,
          fields?: { failureReason?: string; estimatedRecipientCount?: number },
        ) {
          if (opts.transitionThrowsOn === status) {
            // Not a concurrent cancel — a serialization failure or a statement
            // timeout, i.e. the terminal write genuinely did not land.
            throw new Error('40001 could not serialize access');
          }
          rec.transitions.push({
            status,
            failureReason: fields?.failureReason,
            estimatedRecipientCount: fields?.estimatedRecipientCount,
            txId: (tx as { txId?: number } | null)?.txId,
          });
          return { ...broadcast, status };
        },
      },
      broadcastsGateway: {
        async createAudience(name: string) {
          maybeThrow('createAudience');
          return { audienceId: `aud-${name}` };
        },
        async createContactImport() {
          maybeThrow('createContactImport');
          return { importId: 'imp-new' };
        },
        async getContactImport() {
          maybeThrow('getContactImport');
          return {
            status: opts.importStatus ?? 'completed',
            counts:
              opts.counts ?? {
                total: RECIPIENTS.length,
                created: RECIPIENTS.length,
                updated: 0,
                skipped: 0,
                failed: 0,
              },
          };
        },
        async createBroadcast() {
          maybeThrow('createBroadcast');
          return { broadcastId: 'rb-1' };
        },
        async sendBroadcast(id: string) {
          maybeThrow('sendBroadcast');
          rec.sends.push(id);
        },
      },
      audit: {
        async emit(tx: unknown, e: { eventType: string; payload: Record<string, unknown> }) {
          // Round 3 finding 3-8 — a failing audit INSERT. In production this
          // aborts the surrounding transaction (25P02), which is why WHICH tx it
          // runs in decides what survives.
          if (opts.auditThrowsOn === e.eventType) {
            throw new Error('audit insert failed');
          }
          rec.audits.push({
            eventType: e.eventType,
            payload: e.payload,
            txId: (tx as { txId?: number } | null)?.txId,
          });
        },
      },
    },
  };
}

const POLLING = { audienceImportId: 'imp-1', resendAudienceId: 'aud-1' } as const;

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('buildAudienceTick — a permanent gateway failure is terminal, not an eternal retry', () => {
  /**
   * The measured case, not a hypothetical: `resend-contact-import.test.ts` pins
   * that a 4xx rejects with `{kind:'permanent'}` and names the exact message
   * Resend returns at the Free plan's contact cap. Before this fix the throw
   * escaped to the cron's per-row catch, which counts `uncaught_error` — the
   * bucket reserved for programming bugs — and left the row `approved`, so the
   * next tick re-uploaded the full member email list to the processor. Every
   * five minutes. For ever.
   */
  it('createContactImport throwing `permanent` moves the row to failed_to_dispatch', async () => {
    const { deps, rec } = makeDeps({ throwOn: { method: 'createContactImport', kind: 'permanent' } });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
    expect(rec.audits.map((a) => a.eventType)).toContain('broadcast_failed_to_dispatch');
  });

  it('records `failureReason` on the transition, because the FR-021 email renders it', async () => {
    const { deps, rec } = makeDeps({ throwOn: { method: 'createContactImport', kind: 'permanent' } });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    const [t] = rec.transitions;
    expect(t?.failureReason).toBeDefined();
    expect(t?.failureReason).not.toBe('');
  });

  it('tells the member, so they can re-submit instead of waiting on silence', async () => {
    const { deps, rec } = makeDeps({ throwOn: { method: 'createContactImport', kind: 'permanent' } });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(rec.memberEmails).toHaveLength(1);
    expect(rec.memberEmails[0]?.templateKey).toBe('broadcast_failed_to_dispatch');
  });

  it('counts the failure, so the rate is not 0 through a total outage', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'failedToDispatchCount');
    const { deps } = makeDeps({ throwOn: { method: 'createContactImport', kind: 'permanent' } });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('createAudience throwing `permanent` is terminal too — the throw is not method-specific', async () => {
    const { deps, rec } = makeDeps({ throwOn: { method: 'createAudience', kind: 'permanent' } });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
  });

  it('getContactImport throwing `permanent` on a polling tick is terminal', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      throwOn: { method: 'getContactImport', kind: 'permanent' },
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
  });
});

describe('buildAudienceTick — a retryable gateway failure stays retryable', () => {
  /**
   * POSITIVE CONTROL for the block above. If every throw went terminal, a
   * transient Neon or Resend blip would burn a broadcast that only needed the
   * next tick. The two directions have to be asserted together or "terminal"
   * is indistinguishable from "over-eager".
   */
  it('leaves the row `approved` and writes no audit, so the next tick retries', async () => {
    const { deps, rec } = makeDeps({ throwOn: { method: 'createContactImport', kind: 'retryable' } });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions).toEqual([]);
    expect(rec.audits).toEqual([]);
    expect(rec.memberEmails).toEqual([]);
  });

  it('reports a retryable kind the cron already routes, not `uncaught_error`', async () => {
    const { deps } = makeDeps({ throwOn: { method: 'createContactImport', kind: 'retryable' } });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('dispatch.server_error');
  });
});

describe('buildAudienceTick — a resolver refusal is a decision, not a pass-through', () => {
  /**
   * The cron counts `too_large` and `post_suppression_empty` as
   * `permanent_failed` under a comment stating the use case has already moved
   * the row and audited it. That was false for both. The row stayed `approved`,
   * so it was re-claimed every tick for ever while the counter that means
   * "finished, nothing to do" ticked up beside it.
   */
  it.each([
    ['too_large', 'broadcast_audience_too_large'],
    ['empty', 'broadcast_audience_post_suppression_empty'],
  ] as const)('resolver %s → failed_to_dispatch + audit', async (mode, expectedKind) => {
    const { deps, rec } = makeDeps({ resolveFails: mode });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe(expectedKind);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
    expect(rec.audits.map((a) => a.eventType)).toContain('broadcast_failed_to_dispatch');
    expect(rec.memberEmails).toHaveLength(1);
  });

  /**
   * `malformed_segment` is a DATA defect: the row's own `segment_params` cannot
   * be parsed, and no number of retries changes that. The single-tick path
   * learned this on 2026-09-07 and made it terminal, with a comment describing
   * the exact symptom. This path re-introduced it — falling through to
   * `dispatch.server_error`, which the cron classifies retryable — while its
   * own comment claimed parity with the path it diverged from.
   */
  it('resolver malformed_segment is TERMINAL, not a transient server error', async () => {
    const { deps, rec } = makeDeps({ resolveFails: 'malformed_segment' });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).not.toBe('dispatch.server_error');
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
  });

  /**
   * POSITIVE CONTROL: a genuinely transient resolver failure must NOT be
   * terminal. Without this, "malformed_segment is terminal" passes just as well
   * when every resolver refusal is terminal.
   */
  it('resolver resolve.server_error stays retryable and leaves the row alone', async () => {
    const { deps, rec } = makeDeps({ resolveFails: 'server_error' });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('dispatch.server_error');
    expect(rec.transitions).toEqual([]);
    expect(rec.audits).toEqual([]);
  });
});

describe('buildAudienceTick — the send leaves a record', () => {
  /**
   * The legacy path emits `broadcast_send_started` inside the same tx as the
   * transition to `sending`, carrying the audience id, the Resend broadcast id
   * and the recipient count. That row is the GDPR Art. 30 record that N
   * addresses were disclosed to a processor at a given time. The import path
   * emitted nothing at all on success — and the emission-site parity test could
   * not see it, because the legacy path still has an emit site for that event.
   */
  it('emits broadcast_send_started on a successful send', async () => {
    const { deps, rec } = makeDeps({ ...POLLING, audienceImportSubmittedAt: NOW });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(true);
    expect(rec.sends).toHaveLength(1);
    expect(rec.audits.map((a) => a.eventType)).toContain('broadcast_send_started');
  });

  it('the audit payload carries the recipient count that was actually sent to', async () => {
    const { deps, rec } = makeDeps({ ...POLLING, audienceImportSubmittedAt: NOW });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    const row = rec.audits.find((a) => a.eventType === 'broadcast_send_started');
    expect(row?.payload['recipientCount']).toBe(RECIPIENTS.length);
  });

  it('counts the dispatch, so the throughput dashboard is not 0 while sends happen', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'cronDispatchedCount');
    const { deps } = makeDeps({ ...POLLING, audienceImportSubmittedAt: NOW });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(spy).toHaveBeenCalled();
  });

  it('re-stamps estimatedRecipientCount at send, so the row is not left with a submit-time guess', async () => {
    const { deps, rec } = makeDeps({ ...POLLING, audienceImportSubmittedAt: NOW });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    const sending = rec.transitions.find((t) => t.status === 'sending');
    expect(sending?.estimatedRecipientCount).toBe(RECIPIENTS.length);
  });
});

describe('buildAudienceTick — an impossible row fails closed', () => {
  /**
   * `0298`'s coherence CHECK is an implication, not an iff, so it admits
   * `(audience_import_id set, audience_import_submitted_at NULL)`. In that state
   * `ageMs` computed 0, which is never greater than the 30-minute threshold, so
   * the row polled for ever — and the gauge could not see it either, because
   * `NULL < now() - interval '30 minutes'` is false. Invisible in both places at
   * once. A state that cannot legally exist should be judged stuck immediately,
   * not brand new.
   */
  it('an import id with no submitted-at is stuck immediately, not pending', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: null,
      importStatus: 'pending',
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('audience_import_stuck');
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
  });

  /**
   * POSITIVE CONTROL: a legitimately young pending import must still be
   * pending, or the case above passes by making everything stuck.
   */
  it('a fresh pending import is still pending', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: new Date(NOW.getTime() - 60_000),
      importStatus: 'pending',
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.kind).toBe('import_pending');
    expect(rec.transitions).toEqual([]);
  });

  /**
   * S47 — the provider's own answer was thrown away. An explicit `failed` was
   * treated as "not completed yet" and polled for another 29 minutes, then
   * audited with reason `stuck` — the wrong cause, in an append-only table.
   */
  it('an explicit provider `failed` is terminal at once, not after the 30-minute timeout', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      importStatus: 'failed',
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
    const row = rec.audits.find((a) => a.eventType === 'broadcast_failed_to_dispatch');
    expect(row?.payload['reason']).not.toBe('audience_import_stuck');
  });
});

describe('buildAudienceTick — the completion rule discriminates between its clauses', () => {
  /**
   * S28 — clause ORDER was unpinned. Walking the existing fixtures showed that
   * no case made both the coherence check and the count check true at once, so
   * swapping `counts_incoherent` and `count_mismatch` changed nothing anyone
   * could observe. That is not a cosmetic ordering: the mismatch clause
   * re-resolves the audience, so the order also decides how many resolver round
   * trips a refusal costs.
   *
   * This is the discriminating fixture. `created + updated + skipped` = 1 while
   * `total` = 5 (incoherent), AND `total` = 5 while the resolver answers 3
   * (mismatch). Coherence is checked first because it is a statement about the
   * job's OWN numbers — a job whose parts do not sum cannot be reasoned about
   * against anything external.
   */
  it('reports counts_incoherent, not count_mismatch, when BOTH clauses are true', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      counts: { total: 5, created: 1, updated: 0, skipped: 0, failed: 0 },
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({
        kind: 'audience_import_failed',
        reason: 'counts_incoherent',
      });
    }
    const row = rec.audits.find((a) => a.eventType === 'broadcast_failed_to_dispatch');
    expect(row?.payload['reason']).toBe('counts_incoherent');
  });

  it('POSITIVE CONTROL — coherent counts that merely disagree with the resolver are count_mismatch', async () => {
    // Without this, the case above passes if `counts_incoherent` were returned
    // for every refusal.
    const { deps } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      counts: { total: 5, created: 5, updated: 0, skipped: 0, failed: 0 },
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({
        kind: 'audience_import_failed',
        reason: 'count_mismatch',
      });
    }
  });
});

describe('buildAudienceTick — attribution the port used to discard', () => {
  /**
   * S55. `ResolvedAudience` narrowed the resolver's answer to
   * `{recipients, estimatedCount}`, so `orphans` and `droppedByPreference` could
   * not reach this file at all — not because a log line was deleted, but because
   * the type refused to carry them. The legacy path logs both per broadcast, and
   * `droppedByPreference` exists BECAUSE a previous review round added it to
   * answer a member asking why their E-Blast reached 40 people instead of 55.
   *
   * Asserted through the audit payload rather than a log line: a log is not a
   * durable record, and this is the number the member's question is about.
   */
  it('carries droppedByPreference through to the send record', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      droppedByPreference: 12,
    });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    const row = rec.audits.find((a) => a.eventType === 'broadcast_send_started');
    expect(row?.payload['droppedByPreference']).toBe(12);
  });

  it('carries the orphan count through to the send record', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      orphans: ['m-7', 'm-9'],
    });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    const row = rec.audits.find((a) => a.eventType === 'broadcast_send_started');
    expect(row?.payload['orphanCount']).toBe(2);
  });

  /**
   * S56 — the AS5 / T171 forensic audit. A member who changes tier between
   * approve and the confirming tick still gets their broadcast sent (correct),
   * but the legacy path writes `broadcast_sent_with_expired_member_plan` so an
   * admin auditing "this member sent an E-Blast as if they still held the lower
   * tier" finds evidence. `BuildAudienceTickDeps` had no `plansBridge` at all,
   * so the check was unrepresentable rather than merely omitted.
   */
  it('emits the expired-plan forensic row when the sender changed tier mid-flight', async () => {
    const { deps, rec } = makeDeps({ ...POLLING, audienceImportSubmittedAt: NOW });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(true);
    expect(rec.plansChecked).toContain('m-1');
    expect(rec.audits.map((a) => a.eventType)).toContain(
      'broadcast_sent_with_expired_member_plan',
    );
  });

  /**
   * Round 2 R2-1 / round 3 finding 3-13 — the compare-and-set round 1 added to
   * `attachAudienceId` / `attachAudienceImport` throws when a concurrent tick
   * attached a different audience or import. NEITHER call sat inside
   * `viaGateway` or any try/catch, so the throw escaped this use case and the
   * cron counted it `uncaught_error` — the bucket that means "a fault in our own
   * code" — for the benign race the CAS was added to make survivable.
   *
   * The assertion that matters is the ABSENCE: no transition, no audit row, no
   * member email. The other tick owns this broadcast now; writing a terminal
   * state or emailing the member here is how a delivered broadcast gets recorded
   * as failed.
   */
  for (const method of ['attachAudienceId', 'attachAudienceImport'] as const) {
    it(`${method} losing its compare-and-set → invalid_state_transition, no state written, nobody told`, async () => {
      const { deps, rec } = makeDeps({
        // `attachAudienceId` only runs when there is no audience yet.
        resendAudienceId: method === 'attachAudienceId' ? null : 'aud-existing',
        casThrowOn: method,
        casThrow: 'concurrent',
      });

      const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('broadcast_invalid_state_transition');
      // The status comes from the repo's own probe of the row, not from a
      // literal — a hardcoded status in this position is the actor-role
      // fabrication class in a different field.
      expect(
        (res.error as { observedStatus?: string }).observedStatus,
      ).toBe('sending');
      expect(rec.transitions).toHaveLength(0);
      expect(rec.audits).toHaveLength(0);
      expect(rec.memberEmails).toHaveLength(0);
    });

    it(`${method} finding the row GONE → broadcast_not_found, not a false failure`, async () => {
      const { deps, rec } = makeDeps({
        resendAudienceId: method === 'attachAudienceId' ? null : 'aud-existing',
        casThrowOn: method,
        casThrow: 'not_found',
      });

      const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('broadcast_not_found');
      expect(rec.transitions).toHaveLength(0);
      expect(rec.memberEmails).toHaveLength(0);
    });

    /**
     * Positive control. Without this, `catch { return err(benign) }` would pass
     * every case above while swallowing a serialization failure — the shape that
     * turns a real fault into a five-minute retry loop nobody is paged about.
     */
    it(`${method} throwing something that is NOT a lost race still propagates`, async () => {
      const { deps } = makeDeps({
        resendAudienceId: method === 'attachAudienceId' ? null : 'aud-existing',
        casThrowOn: method,
        casThrow: 'other',
      });

      await expect(
        buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID }),
      ).rejects.toThrow(/40001/);
    });
  }

  /**
   * Round 3 finding 3-3 (= round 2's R2-8 / R2-27) — `classifyResendError`
   * distinguishes FOUR kinds and `viaGateway` flattened them to a boolean, so
   * `idempotency_conflict` (409) and `resource_missing` (404) both became
   * `gateway_permanent` → `failTerminally`. The legacy path routes both
   * specially, and has since 2026-05-02.
   *
   * These two cases are about what gets WRITTEN and SAID, not about the returned
   * kind — a false row in an append-only table and a false email are the damage.
   */
  it('a 409 on the SEND is a success replay: the mail is out, so do not record a failure', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      throwOn: { method: 'sendBroadcast', kind: 'idempotency_conflict' },
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.kind).toBe('sent');
    // Advances to `sending` exactly as a clean send does — a replay must not
    // leave the row `approved` for the next tick to send AGAIN.
    expect(rec.transitions.map((t) => t.status)).toEqual(['sending']);
    expect(rec.transitions.some((t) => t.status === 'failed_to_dispatch')).toBe(false);
    // Emitted once, not twice: the Art. 30 disclosure record must not double.
    expect(
      rec.audits.filter((a) => a.eventType === 'broadcast_send_started'),
    ).toHaveLength(1);
    // And nobody is told a delivered broadcast failed.
    expect(rec.memberEmails).toHaveLength(0);
  });

  it('a 404 is an ops issue: terminal with its OWN audit event, and the member is NOT emailed', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      throwOn: { method: 'sendBroadcast', kind: 'resource_missing' },
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
    // The distinct event type is the point: grouping the audit log by
    // `broadcast_failed_to_dispatch` must not hide a missing Resend resource
    // among genuine dispatch failures.
    expect(rec.audits.map((a) => a.eventType)).toContain(
      'broadcast_resend_resource_missing',
    );
    expect(rec.audits.map((a) => a.eventType)).not.toContain(
      'broadcast_failed_to_dispatch',
    );
    // "resource_missing is an ops-side issue requiring admin action, not member
    // notification" — the legacy path's own words.
    expect(rec.memberEmails).toHaveLength(0);
  });

  /**
   * Positive control #1: a 409 raised BEFORE `createBroadcast` has no broadcast
   * to advance to, so it must NOT be laundered into a success. Without this, an
   * arm that returned `ok` for every `idempotency_conflict` would pass the replay
   * case above while reporting sends that never happened.
   */
  it('a 409 on createBroadcast is NOT a replay — there is nothing to advance to', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      throwOn: { method: 'createBroadcast', kind: 'idempotency_conflict' },
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
    expect(rec.sends).toHaveLength(0);
  });

  /**
   * Positive control #2: an ordinary `permanent` 4xx — the measured Free-plan
   * cap — must still be a full failure WITH the member email. The two arms above
   * are narrow exceptions, not a new default.
   */
  /**
   * Round 3 finding 3-15 — `onResolveFailure` awaited `failTerminally` and threw
   * its Result away, and `failTerminally` returned the SAME `err(error)` whether
   * the terminal write committed or not. So a broadcast whose terminal write
   * kept failing was reported as `broadcast_audience_too_large`, which the cron
   * counts `permanent_failed` — the bucket meaning "finished, nothing left to
   * do", so no alert could fire — while the row sat `approved` and was re-claimed
   * every five minutes for ever. That is the exact failure mode
   * `onResolveFailure`'s own docblock says it exists to remove.
   *
   * The assertion is about the KIND the caller sees, because that kind is the
   * cron's bucket, and the bucket is what decides whether anyone is told.
   */
  it('a terminal write that does NOT commit is reported as transient, not as "done"', async () => {
    const { deps, rec } = makeDeps({
      resolveFails: 'too_large',
      transitionThrowsOn: 'failed_to_dispatch',
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // NOT `broadcast_audience_too_large` — that reaches the cron's
    // `permanent_failed` arm, whose comment promises the row has already been
    // moved and audited. It has not.
    expect(res.error.kind).toBe('dispatch.server_error');
    expect(rec.transitions).toHaveLength(0);
    // And the member is not told a broadcast failed when nothing was recorded —
    // a concurrent cancel is the likeliest cause of the write failing.
    expect(rec.memberEmails).toHaveLength(0);
  });

  /**
   * Round 3 finding 3-8 — the two audit emits need OPPOSITE transaction
   * semantics, and both were wrong in the same direction.
   *
   * On the send path the mail is already delivered. `safeAuditEmit` ran inside
   * the same tx as `attachResendIds` + `applyTransition('sending')` and swallowed
   * the INSERT failure, so the aborted transaction committed as a ROLLBACK and
   * BOTH writes were discarded while the function reported `ok({kind:'sent'})` —
   * leaving the row `approved` for the next tick to send the whole broadcast
   * again. The audit row is the recoverable loss; a second send to a chamber's
   * entire list is not.
   */
  it('send path: a failed audit INSERT loses the audit row, NOT the sending transition', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      auditThrowsOn: 'broadcast_send_started',
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(true);
    // The load-bearing assertion: the row moved. If this is empty the next tick
    // re-sends.
    expect(rec.transitions.map((t) => t.status)).toEqual(['sending']);
    expect(rec.audits.map((a) => a.eventType)).not.toContain('broadcast_send_started');
  });

  /**
   * The mechanism, asserted directly. A unit harness cannot reproduce Postgres
   * 25P02 abort semantics, so "the transition survived" alone would pass under
   * the pre-fix code too. What actually decides the outcome is WHICH transaction
   * each write is in — and that is observable.
   */
  it('send path: the Art. 30 record is written in a DIFFERENT transaction from the transition', async () => {
    const { deps, rec } = makeDeps({ ...POLLING, audienceImportSubmittedAt: NOW });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    const sending = rec.transitions.find((t) => t.status === 'sending');
    const record = rec.audits.find((a) => a.eventType === 'broadcast_send_started');
    expect(sending?.txId).toBeDefined();
    expect(record?.txId).toBeDefined();
    expect(record?.txId).not.toBe(sending?.txId);
  });

  /**
   * And the inverse for the failure path — same finding, opposite requirement.
   * Nothing was sent, so the terminal state and its audit row must stand or fall
   * together.
   */
  it('failure path: the terminal transition and its audit row share ONE transaction', async () => {
    const { deps, rec } = makeDeps({ resolveFails: 'too_large' });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    const terminal = rec.transitions.find((t) => t.status === 'failed_to_dispatch');
    const record = rec.audits.find((a) => a.eventType === 'broadcast_failed_to_dispatch');
    expect(terminal?.txId).toBeDefined();
    expect(record?.txId).toBe(terminal?.txId);
  });

  it('send path: the audit-volume counter is not incremented for a row that was not written', async () => {
    const spy = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const { deps } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      auditThrowsOn: 'broadcast_send_started',
    });

    await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    // It used to fire unconditionally on the line after the swallow, so the
    // audit-volume series reported rows that did not exist while the loss was
    // reported on a different series entirely.
    expect(
      spy.mock.calls.filter((c) => c[1] === 'broadcast_send_started'),
    ).toHaveLength(0);
  });

  /**
   * The opposite direction, same finding. On the FAILURE path nothing has been
   * sent, so a terminal state without its audit row is the worse outcome — and
   * emailing the member that their broadcast failed while the row sits
   * `approved` is worse still.
   */
  it('failure path: a failed audit INSERT tears the terminal transition down and tells nobody', async () => {
    const { deps, rec } = makeDeps({
      resolveFails: 'too_large',
      auditThrowsOn: 'broadcast_failed_to_dispatch',
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('dispatch.server_error');
    expect(rec.memberEmails).toHaveLength(0);
  });

  it('an ordinary permanent 4xx still fails terminally AND still tells the member', async () => {
    const { deps, rec } = makeDeps({
      ...POLLING,
      audienceImportSubmittedAt: NOW,
      throwOn: { method: 'sendBroadcast', kind: 'permanent' },
    });

    const res = await buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });

    expect(res.ok).toBe(false);
    expect(rec.transitions.map((t) => t.status)).toEqual(['failed_to_dispatch']);
    expect(rec.audits.map((a) => a.eventType)).toContain('broadcast_failed_to_dispatch');
    expect(rec.memberEmails).toHaveLength(1);
  });
});
