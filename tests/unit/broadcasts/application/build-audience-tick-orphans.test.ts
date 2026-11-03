/**
 * Spec 140 s2c — the import leg's orphan writers (DL5b, DL6; plan.md § Slice 2c,
 * item 3). Each row is written at the CALLER that holds the id and the
 * requester, never inside a shared gateway helper [A2]:
 *
 *   - `dead_broadcast_replaced` — a dead inherited id replaced by a fresh mint,
 *     ONLY when the probe read `cancelled` (a `not_found` id is gone) [A7];
 *   - `dead_broadcast_kept` — a restart that could not delete a cancelled id;
 *   - `audience_leaked` — `reclaimUnattachedAudience` at both of its leaks;
 *   - `refused_draft_undeleted` — a standing refusal whose DELETE stayed
 *     undecided (R1 #5);
 *   - `create_unconfirmed` — `createBroadcast` ended in a network failure, a
 *     timeout or a 5xx (never a 429, which created nothing, nor a permanent 4xx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick, type BuildAudienceTickDeps } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { RecordOrphanInput } from '@/modules/broadcasts/application/ports/broadcast-orphans-repo';
import { makeFakeSendStanding, type FakeSendStandingOpts } from '../../../helpers/eblast-approval-fakes';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('55555555-5555-4555-8555-555555555555');
const NOW = new Date('2026-11-03T03:00:00Z');
const RECIPIENTS = ['a@example.com', 'b@example.com'];
const TOKEN = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MEMBER = 'm-1';
const TICK2_ROW = { resendAudienceId: 'aud-1', audienceImportId: 'imp-1', audienceImportSubmittedAt: new Date(NOW.getTime() - 600_000) };

type DepsWithEveryPort = { [K in keyof BuildAudienceTickDeps]: unknown };
type DeleteOnce = 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other';
type RetrieveOnce = { kind: 'present'; status: string } | { kind: 'not_found' } | { kind: 'retryable' };

interface Opts {
  readonly row?: Partial<{
    resendAudienceId: string | null;
    audienceImportId: string | null;
    audienceImportSubmittedAt: Date | null;
    resendBroadcastId: string | null;
  }>;
  readonly standing?: FakeSendStandingOpts;
  readonly probe?: 'draft' | 'cancelled' | 'not_found';
  /** `createBroadcast` throws this (a `GatewayThrowable`-shaped object). */
  readonly createBroadcastThrows?: Record<string, unknown>;
  /** `deleteBroadcast` (the restart's) throws a permanent 403. */
  readonly deleteBroadcastForbidden?: boolean;
  readonly deleteAudienceThrows?: boolean;
  readonly attachAudienceIdThrows?: 'lease_lost' | 'db_fault';
  readonly readBackThrows?: boolean;
  readonly deleteOnce?: DeleteOnce;
  readonly retrieveOnce?: RetrieveOnce;
  /** What the import poll answers (`failed` → a terminal `provider_failed`). Default `completed`. */
  readonly importStatus?: string;
  /** The choke point's re-read (`findById`): fields over the snapshot, or a throw. */
  readonly reread?: Partial<{ resendBroadcastId: string | null; status: string }> | 'throws';
  /** What each successive lease check answers; the last one repeats. Default always `held`. */
  readonly checks?: ReadonlyArray<'held' | 'lost' | 'expiring' | 'throws'>;
  /** The resolver refuses: the audience grew past the ceiling. */
  readonly resolveTooLarge?: boolean;
}

function harness(opts: Opts = {}) {
  const events: string[] = [];
  const recorded: RecordOrphanInput[] = [];
  const audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const memberEmails: unknown[] = [];
  const checks = opts.checks ?? ['held'];
  let checkIndex = 0;
  let attachAttempted = false;
  const broadcast = {
    broadcastId: BROADCAST_ID,
    tenantId: tenant.slug,
    status: 'approved' as const,
    subject: 'Hello',
    bodyHtml: '<p>hi</p>',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    requestedByMemberId: MEMBER,
    segmentType: 'all_members' as const,
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: RECIPIENTS.length,
    scheduledFor: null,
    approvedAt: NOW,
    createdAt: NOW,
    resendAudienceId: null as string | null,
    audienceImportId: null as string | null,
    audienceImportSubmittedAt: null as Date | null,
    audienceImportCompletedAt: null,
    resendBroadcastId: null as string | null,
    dispatchFirstFailedAt: null as Date | null,
    ...opts.row,
  };
  const deps: DepsWithEveryPort = {
    tenant,
    clock: { now: () => NOW },
    tickBudget: { tickStartedAt: NOW.getTime() },
    fromEmail: 'noreply@example.com',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    brandChrome: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
    resolveRecipients: async () =>
      opts.resolveTooLarge === true
        ? err({ kind: 'broadcast_audience_too_large' as const, count: 99_999, cap: 900 })
        : ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
    broadcastsRepo: {
      async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(null);
      },
      async lockForUpdate() {
        return 'approved';
      },
      async claimDispatchLease() {
        return TOKEN;
      },
      async checkDispatchLease(_tx: unknown, _t: unknown, _b: unknown, _lease: unknown, headroomMs: number) {
        const answer = checks[Math.min(checkIndex, checks.length - 1)]!;
        checkIndex += 1;
        events.push(`check:${headroomMs}:${answer}`);
        if (answer === 'throws') throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        return answer;
      },
      async releaseDispatchLease() {
        return true;
      },
      async findByIdInTx() {
        return broadcast;
      },
      async findById() {
        if (attachAttempted && opts.readBackThrows === true) throw new Error('57P01 terminating connection');
        if (!attachAttempted) {
          events.push('reread');
          if (opts.reread === 'throws') throw new Error('57P01 terminating connection');
          if (opts.reread !== undefined) return { ...broadcast, ...opts.reread };
        }
        return broadcast;
      },
      async attachAudienceId() {
        attachAttempted = true;
        if (opts.attachAudienceIdThrows === 'lease_lost') {
          throw new (BroadcastConcurrentMutationError as unknown as new (...a: unknown[]) => Error)(tenant.slug, BROADCAST_ID, 'lease_lost');
        }
        if (opts.attachAudienceIdThrows === 'db_fault') throw new Error('08006 connection failure');
      },
      async attachAudienceImport() {},
      async attachBroadcastId() {},
      async attachResendIds() {},
      async applyTransition(_tx: unknown, _t: unknown, _b: unknown, target: string) {
        events.push(`transition:${target}`);
        return { ...broadcast, status: target };
      },
      async markAudienceImportCompleted() {},
      async markDispatchRetryStarted(_tx: unknown, _t: unknown, _b: unknown, at: Date) {
        return at;
      },
      async clearDispatchRetryClock() {},
      async releaseAudienceImport() {
        return 'ok' as const;
      },
      async releaseResendAudience() {
        return 'ok' as const;
      },
      async readAlreadySentEvidenceInTx() {
        return { broadcastRecorded: false, memberBroadcastCount: 0 };
      },
    },
    broadcastsGateway: {
      async retrieveBroadcast(id: string) {
        if (opts.probe === 'not_found') return { kind: 'not_found' as const };
        return { kind: 'present' as const, resource: { id, status: opts.probe ?? 'draft', sentAt: null } };
      },
      async createAudience() {
        return { audienceId: 'aud-new' };
      },
      async createContactImport() {
        return { importId: 'imp-new' };
      },
      async getContactImport() {
        return {
          status: opts.importStatus ?? 'completed',
          counts: { total: RECIPIENTS.length, created: RECIPIENTS.length, updated: 0, skipped: 0, failed: 0 },
        };
      },
      async getAudienceContactCount() {
        return { count: RECIPIENTS.length, complete: true };
      },
      async createBroadcast() {
        events.push('gw:createBroadcast');
        if (opts.createBroadcastThrows !== undefined) throw opts.createBroadcastThrows;
        return { broadcastId: 'rb-minted' };
      },
      async sendBroadcast() {
        events.push('gw:sendBroadcast');
      },
      async deleteBroadcast(id: string) {
        events.push(`gw:deleteBroadcast:${id}`);
        if (opts.deleteBroadcastForbidden === true) throw { kind: 'permanent', code: 'validation_error', reason: '403' };
      },
      async deleteAudience(id: string) {
        events.push(`gw:deleteAudience:${id}`);
        if (opts.deleteAudienceThrows === true) throw { kind: 'retryable', subKind: 'timeout', reason: 'aborted' };
      },
      async deleteBroadcastOnce(id: string) {
        events.push(`gw:deleteBroadcastOnce:${id}`);
        return { kind: opts.deleteOnce ?? 'deleted' };
      },
      async retrieveBroadcastOnce(id: string) {
        events.push(`gw:retrieveBroadcastOnce:${id}`);
        return opts.retrieveOnce ?? { kind: 'not_found' as const };
      },
    },
    orphans: {
      async recordOrphanedResendId(input: RecordOrphanInput) {
        events.push(`orphan:${input.reason}`);
        recorded.push(input);
      },
    },
    audit: {
      async emit(_tx: unknown, e: { eventType: string; payload: Record<string, unknown> }) {
        audits.push({ eventType: e.eventType, payload: e.payload });
      },
    },
    membersBridge: {
      async getMemberPrimaryContact() {
        return 'member@example.com';
      },
      async getMemberPreferredLocale() {
        return 'en' as const;
      },
    },
    emailTransactional: {
      async sendMemberEmail(_t: unknown, m: unknown) {
        memberEmails.push(m);
      },
    },
    plansBridge: { async getPlanForMember() { return ok({ planId: 'plan-1', planCode: 'CORP', eblastPerYear: 12 }); } },
    sendStanding: makeFakeSendStanding(opts.standing),
    pauseBeforeReprobe: async () => {},
  };
  const run = () => buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });
  return { run, events, recorded, audits, memberEmails };
}

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

const row = (reason: string, resourceId: string | null, resourceType: 'broadcast' | 'audience' = 'broadcast'): RecordOrphanInput => ({
  broadcastId: BROADCAST_ID,
  requestedByMemberId: MEMBER,
  resourceType,
  resourceId,
  reason: reason as RecordOrphanInput['reason'],
});

describe('spec 140 s2c — the import leg records its orphans at the caller', () => {
  it('[A7] a cancelled inherited id replaced by a fresh mint → dead_broadcast_replaced with the REPLACED id', async () => {
    const h = harness({ row: { ...TICK2_ROW, resendBroadcastId: 'rb-dead' }, probe: 'cancelled' });
    const res = await h.run();
    expect(res.ok).toBe(true);
    expect(h.recorded).toEqual([row('dead_broadcast_replaced', 'rb-dead')]);
  });

  it('[A7] a not_found inherited id replaced by a fresh mint → no row (Resend holds nothing)', async () => {
    const h = harness({ row: { ...TICK2_ROW, resendBroadcastId: 'rb-gone' }, probe: 'not_found' });
    const res = await h.run();
    expect(res.ok).toBe(true);
    expect(h.recorded).toEqual([]);
  });

  it('a hold whose restart cannot delete a cancelled id keeps it → dead_broadcast_kept', async () => {
    const h = harness({
      row: { ...TICK2_ROW, resendBroadcastId: 'rb-dead' },
      probe: 'cancelled',
      standing: { access: 'suspended' },
      deleteBroadcastForbidden: true,
    });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'dispatch_held_member_suspended' });
    expect(h.recorded).toEqual([row('dead_broadcast_kept', 'rb-dead')]);
  });

  it('a hold whose restart deletes the broadcast id → no row', async () => {
    const h = harness({ row: { ...TICK2_ROW, resendBroadcastId: 'rb-dead' }, probe: 'cancelled', standing: { access: 'suspended' } });
    await h.run();
    expect(h.recorded).toEqual([]);
  });

  it('a lost audience attach whose delete fails → audience_leaked (resource_type audience)', async () => {
    const h = harness({ attachAudienceIdThrows: 'lease_lost', deleteAudienceThrows: true });
    await h.run();
    expect(h.recorded).toEqual([row('audience_leaked', 'aud-new', 'audience')]);
  });

  it('a faulted audience attach whose read-back fails → audience_leaked, and nothing is deleted', async () => {
    const h = harness({ attachAudienceIdThrows: 'db_fault', readBackThrows: true });
    await h.run();
    expect(h.events.filter((e) => e.startsWith('gw:deleteAudience'))).toEqual([]);
    expect(h.recorded).toEqual([row('audience_leaked', 'aud-new', 'audience')]);
  });

  it('a lost audience attach whose delete works → no row', async () => {
    const h = harness({ attachAudienceIdThrows: 'lease_lost' });
    await h.run();
    expect(h.recorded).toEqual([]);
  });

  it('R1 #5 — a halted refusal whose DELETE stays undecided → refused_draft_undeleted, then terminal, ONE delete', async () => {
    const h = harness({
      row: { ...TICK2_ROW, resendBroadcastId: 'rb-draft' },
      probe: 'draft',
      standing: { halted: [MEMBER] },
      deleteOnce: 'retryable',
    });
    await h.run();
    expect(h.recorded).toEqual([row('refused_draft_undeleted', 'rb-draft')]);
    expect(h.events.filter((e) => e.startsWith('gw:deleteBroadcastOnce'))).toEqual(['gw:deleteBroadcastOnce:rb-draft']);
    expect(h.events.indexOf('orphan:refused_draft_undeleted')).toBeLessThan(h.events.indexOf('transition:failed_to_dispatch'));
  });

  it('a halted refusal whose DELETE lands → no row', async () => {
    const h = harness({ row: { ...TICK2_ROW, resendBroadcastId: 'rb-draft' }, probe: 'draft', standing: { halted: [MEMBER] } });
    await h.run();
    expect(h.recorded).toEqual([]);
  });

  it.each([
    ['network', { kind: 'retryable', subKind: 'network', reason: 'fetch failed' }],
    ['timeout', { kind: 'retryable', subKind: 'timeout', reason: 'aborted' }],
    ['server_5xx', { kind: 'retryable', subKind: 'server_5xx', reason: '502' }],
  ] as const)('DL5b — createBroadcast ends in %s → create_unconfirmed with no id', async (_label, thrown) => {
    const h = harness({ row: TICK2_ROW, createBroadcastThrows: thrown });
    await h.run();
    expect(h.recorded).toEqual([row('create_unconfirmed', null)]);
  });

  it.each([
    ['a 429 (api)', { kind: 'retryable', subKind: 'api', reason: '429' }],
    ['a permanent 4xx', { kind: 'permanent', code: 'validation_error', reason: '422' }],
  ] as const)('DL5b — createBroadcast refused with %s → no row (nothing was created)', async (_label, thrown) => {
    const h = harness({ row: TICK2_ROW, createBroadcastThrows: thrown });
    await h.run();
    expect(h.recorded).toEqual([]);
  });
});

/**
 * Spec 140 s2c, item 4 — the choke point in `failTerminally` (pdpa M-1, design
 * item 10): before ANY terminal write on the import leg, the row is RE-READ
 * [A3]; when it holds a Resend draft id, the lease is checked [A4] and the
 * draft is deleted with `deleteDraftBeforeStandingRefusal` [A2], whose full
 * outcome set decides the answer. The two refuse arms pass `draftSettled` and
 * are not deleted twice.
 *
 * The path used: tick 2 with the import answering `failed` → a terminal
 * `provider_failed`. The SNAPSHOT row has no broadcast id; only the re-read
 * carries `rb-late` (a sibling's persist after this tick's Step 1), so a
 * choke point that trusted the snapshot would delete nothing.
 */
describe('spec 140 s2c — the failTerminally choke point', () => {
  const TERMINAL = { row: TICK2_ROW, importStatus: 'failed', reread: { resendBroadcastId: 'rb-late' } } as const;
  const calls = (h: ReturnType<typeof harness>) =>
    h.events.filter((e) => e === 'reread' || e.startsWith('check:') || e.startsWith('gw:deleteBroadcastOnce') || e.startsWith('gw:retrieveBroadcastOnce') || e.startsWith('transition:') || e.startsWith('orphan:'));

  it('[A3] re-reads the row, checks the lease, deletes the draft the RE-READ holds, then writes terminal with resendDraftOutcome', async () => {
    const h = harness(TERMINAL);
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject({ kind: 'audience_import_failed', reason: 'provider_failed' });
    expect(calls(h)).toEqual(['reread', 'check:25000:held', 'gw:deleteBroadcastOnce:rb-late', 'transition:failed_to_dispatch']);
    expect(h.audits[0]).toMatchObject({ eventType: 'broadcast_failed_to_dispatch', payload: { reason: 'provider_failed', resendDraftOutcome: 'deleted' } });
  });

  it('[A3] a re-read that fails answers a retryable dispatch.server_error with no Resend call and no terminal write', async () => {
    const h = harness({ ...TERMINAL, reread: 'throws' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject({ kind: 'dispatch.server_error', phase: 'terminal_write' });
    expect(calls(h)).toEqual(['reread']);
    expect(h.audits).toEqual([]);
    expect(h.memberEmails).toEqual([]);
  });

  it('a re-read with no broadcast id deletes nothing and writes terminal as before', async () => {
    const h = harness({ ...TERMINAL, reread: { resendBroadcastId: null } });
    await h.run();
    expect(calls(h)).toEqual(['reread', 'transition:failed_to_dispatch']);
    expect(h.audits[0]?.payload).not.toHaveProperty('resendDraftOutcome');
  });

  it.each([
    ['lost', { kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' }],
    ['expiring', { kind: 'lease_expiring', step: 'terminal_reclaim' }],
    ['throws', { kind: 'dispatch.server_error', message: 'lease_check_failed', phase: 'lease' }],
  ] as const)('[A4] a lease check that reads %s makes no Resend call and writes nothing terminal', async (answer, expected) => {
    const h = harness({ ...TERMINAL, checks: [answer] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject(expected);
    expect(h.events.filter((e) => e.startsWith('gw:deleteBroadcastOnce'))).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('transition:'))).toEqual([]);
    expect(h.memberEmails).toEqual([]);
  });

  it.each([
    ['deleted', undefined, 'deleted'],
    ['absent', undefined, 'absent'],
    ['forbidden', { kind: 'present', status: 'cancelled' }, 'cancelled'],
    ['forbidden', { kind: 'present', status: 'failed' }, 'failed'],
  ] as const)('DELETE %s (GET %o) → terminal with resendDraftOutcome %s, and no orphan row', async (deleteOnce, retrieveOnce, outcome) => {
    const h = harness({ ...TERMINAL, deleteOnce, ...(retrieveOnce === undefined ? {} : { retrieveOnce }) });
    await h.run();
    expect(h.events).toContain('transition:failed_to_dispatch');
    expect(h.audits[0]?.payload).toMatchObject({ resendDraftOutcome: outcome });
    expect(h.recorded).toEqual([]);
  });

  // Review round 1 (code-review #5): no longer a bare skip — caught up (the
  // round-1 describe below pins the `sending` transition).
  it('DELETE 403 whose GET reads queued (handed) → no terminal write, no member email', async () => {
    const h = harness({ ...TERMINAL, deleteOnce: 'forbidden', retrieveOnce: { kind: 'present', status: 'queued' } });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject({ kind: 'sent' });
    expect(h.events.filter((e) => e.startsWith('transition:'))).toEqual(['transition:sending']);
    expect(h.audits.map((a) => a.eventType)).not.toContain('broadcast_failed_to_dispatch');
    expect(h.memberEmails).toEqual([]);
  });

  it('an undecided DELETE → an orphan row terminal_reclaim_undecided FIRST, then terminal with resendDraftOutcome undeleted', async () => {
    const h = harness({ ...TERMINAL, deleteOnce: 'retryable' });
    await h.run();
    expect(h.recorded).toEqual([row('terminal_reclaim_undecided', 'rb-late')]);
    expect(calls(h)).toEqual([
      'reread',
      'check:25000:held',
      'gw:deleteBroadcastOnce:rb-late',
      'orphan:terminal_reclaim_undecided',
      'transition:failed_to_dispatch',
    ]);
    expect(h.audits[0]?.payload).toMatchObject({ resendDraftOutcome: 'undeleted', resendDraftErrClass: 'retryable' });
  });

  it('the refuse arm passes draftSettled: one delete (the gate\u2019s), no re-read, no second check', async () => {
    const h = harness({ row: { ...TICK2_ROW, resendBroadcastId: 'rb-draft' }, probe: 'draft', standing: { halted: [MEMBER] } });
    await h.run();
    expect(h.events.filter((e) => e.startsWith('gw:deleteBroadcastOnce'))).toEqual(['gw:deleteBroadcastOnce:rb-draft']);
    expect(h.events).not.toContain('reread');
    expect(h.events.filter((e) => e.startsWith('check:'))).toHaveLength(1);
  });
});

/**
 * Spec 140 s2c review round 1:
 *   - code-review #5 — a handed draft at the choke point is the mail going
 *     out: the row is caught up to `sending` through the existing
 *     `catchUpHanded` (the re-read row), instead of a bare skip that would
 *     leave it `approved` and loop;
 *   - reliability M-1 — `onResolveFailure` passes every non-terminal stop
 *     through (`lease_expiring`, the catch-up), so the cron does not count
 *     `permanent_failed` for a row nothing terminal was written to;
 *   - reliability nit — `terminal_reread_failed` names its step.
 */
describe('spec 140 s2c review round 1 — the choke point, continued', () => {
  const TERMINAL = { row: TICK2_ROW, importStatus: 'failed', reread: { resendBroadcastId: 'rb-late' } } as const;

  it('a handed draft at the choke point catches the row up to sending', async () => {
    const h = harness({ ...TERMINAL, deleteOnce: 'forbidden', retrieveOnce: { kind: 'present', status: 'queued' } });
    const res = await h.run();
    expect(h.events).toContain('transition:sending');
    expect(h.events).not.toContain('transition:failed_to_dispatch');
    expect(res.ok ? res.value : res.error).toMatchObject({ kind: 'sent', resendBroadcastId: 'rb-late' });
    expect(h.memberEmails).toEqual([]);
  });

  it.each([
    ['a lease running short', { checks: ['expiring'] as const }, { kind: 'lease_expiring', step: 'terminal_reclaim' }],
    ['a handed draft (caught up)', { deleteOnce: 'forbidden' as const, retrieveOnce: { kind: 'present' as const, status: 'sent' } }, { kind: 'sent' }],
  ])('onResolveFailure passes %s through, not the resolver kind', async (_label, extra, expected) => {
    const h = harness({ reread: { resendBroadcastId: 'rb-late' }, resolveTooLarge: true, ...extra });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject(expected);
    expect(h.events).not.toContain('transition:failed_to_dispatch');
  });

  it('terminal_reread_failed names its step (terminal_reclaim)', async () => {
    const h = harness({ ...TERMINAL, reread: 'throws' });
    await h.run();
    const line = vi.mocked(logger.warn).mock.calls.find((c) => c[1] === 'broadcasts.audience_import.terminal_reread_failed');
    expect(line?.[0]).toMatchObject({ step: 'terminal_reclaim' });
  });
});
