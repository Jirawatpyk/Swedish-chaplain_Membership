/**
 * Spec 140 s2b — `buildAudienceTick` under the dispatch lease.
 *
 * The tick CLAIMS the row in its step-1 lock tx, re-checks the lease before
 * every irreversible Resend call (C + M of headroom; I + M before the import
 * POST), carries the token in every write, and releases it in a `finally`.
 * State-table rows (plan.md § Slice 2): 3 (a held lease skips with no gateway
 * call), 5 (a held check → the call is made), 6 (inside the headroom no call is
 * made), 8 (a lost-token attach after a mint is a skip, and the mint is
 * reclaimed — A2: that reclaim is NOT lease-checked), 9 (a lost lease never
 * writes failed_to_dispatch), DL2 (an expired holder makes no call after the
 * expiry), the restart's deletes and the standing gate's delete are checked
 * first (A8), A4 (a lease lost after `/send` is INFO `lease_lost_after_send`,
 * not the critical `sent_but_transition_lost`), and DL9 (no row starts after
 * the cutoff).
 *
 * The harness records ONE ordered event list — gateway calls, lease checks
 * (with their headroom) and repo writes (with the lease they carried) — so
 * "checked BEFORE the call" is an ordering assertion, not two counters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import type { AudienceDeletedEmitInput } from '@/modules/broadcasts/application/ports/audit-port';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { makeFakeSendStanding, type FakeSendStandingOpts } from '../../../helpers/eblast-approval-fakes';
import type { TickHarnessDeps } from '../../../support/broadcasts/tick-deps-type';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('55555555-5555-4555-8555-555555555555');
const NOW = new Date('2026-11-01T03:00:00Z');
const RECIPIENTS = ['a@example.com', 'b@example.com'];
const TOKEN = 'aaaaaaaa-0000-4000-8000-00000000000a';
/** The values `_dispatch-lease.ts` exports, spelled here so a drift there is a red test, not a moved goalpost. */
const CALL_HEADROOM_MS = 25_000;
const IMPORT_HEADROOM_MS = 45_000;
const LEASE_TTL_MS = 330_000;
const ROW_START_CUTOFF_MS = 121_000;

interface Opts {
  readonly claim?: string | null;
  /** What each successive lease check answers; the last one repeats. Default always `held`. */
  readonly checks?: ReadonlyArray<'held' | 'lost' | 'expiring'>;
  readonly row?: Partial<{
    resendAudienceId: string | null;
    audienceImportId: string | null;
    audienceImportSubmittedAt: Date | null;
    resendBroadcastId: string | null;
  }>;
  readonly attachBroadcastIdThrows?: 'lease_lost';
  readonly attachResendIdsThrows?: 'lease_lost';
  readonly sendingTransitionThrows?: 'lease_lost';
  /** `conflict` = a non-holder CAS loss (the row moved to `cancelled`). */
  readonly terminalTransitionThrows?: 'lease_lost' | 'conflict';
  readonly releaseThrows?: boolean;
  readonly importStatus?: string;
  readonly standing?: FakeSendStandingOpts;
  readonly probe?: 'draft' | 'not_found';
  readonly tickStartedAt?: number;
  /** The resolver refuses: the audience grew past the ceiling. */
  readonly resolveTooLarge?: boolean;
  /** Review round 1 (CR#1) — the row status a `lease_lost` throw reports it probed. */
  readonly lostRowStatus?: string;
  readonly completionStampThrows?: 'lease_lost';
  /** The pre-call check itself throws (e.g. its lock_timeout, 55P03). */
  readonly checkThrows?: boolean;
  /** `createAudience` answers a retryable network failure. */
  readonly createAudienceRetryable?: boolean;
  /** What `markDispatchRetryStarted` answers (`null` = no row matched: here, a lost token). */
  readonly retryStampReturns?: Date | null;
  /** `db_fault` = a throw that is not a repo refusal; `conflict` = a status-drift CAS refusal. */
  readonly attachAudienceIdThrows?: 'lease_lost' | 'db_fault' | 'conflict';
  /** The write committed although the attach threw (a lost ack): the read-back finds the id. */
  readonly attachLandsBeforeFault?: boolean;
  /** The read-back after a failed attach throws. */
  readonly readBackThrows?: boolean;
  readonly deleteAudienceThrows?: boolean;
  /** What the restart's claim (`releaseAudienceImport`) answers. Default: it lands. */
  readonly releaseImportAnswers?: 'lease_lost' | 'cas_lost';
}

function harness(opts: Opts = {}) {
  const events: string[] = [];
  const writeLeases: Array<{ method: string; lease: unknown }> = [];
  const releases: unknown[] = [];
  const memberEmails: unknown[] = [];
  /** Spec 142 review round 3 — the rows `emitOnce` wrote (the restart's deleted row). */
  const deletedRows: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let checkIndex = 0;
  let attachAttempted = false;
  const checks = opts.checks ?? ['held'];
  const broadcast = {
    broadcastId: BROADCAST_ID,
    tenantId: tenant.slug,
    status: 'approved' as const,
    subject: 'Hello',
    bodyHtml: '<p>hi</p>',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    requestedByMemberId: 'm-1',
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
  const leaseLost = () =>
    new (BroadcastConcurrentMutationError as unknown as new (...a: unknown[]) => Error)(
      tenant.slug,
      BROADCAST_ID,
      'lease_lost',
      opts.lostRowStatus,
    );
  const write = (method: string, lease: unknown) => {
    events.push(`write:${method}`);
    writeLeases.push({ method, lease });
  };
  const deps: TickHarnessDeps = {
    tenant,
    clock: { now: () => NOW },
    tickBudget: { tickStartedAt: opts.tickStartedAt ?? NOW.getTime() },
    fromEmail: 'noreply@example.com',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    brandChrome: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
    // Spec 140 s2c - the orphan record; these cases do not read it.
    orphans: { async recordOrphanedResendId() {} },
    resolveRecipients: async () =>
      opts.resolveTooLarge === true
        ? err({ kind: 'broadcast_audience_too_large' as const, count: 99_999, cap: 900 })
        : ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
    broadcastsRepo: {
      async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(null);
      },
      async lockForUpdate() {
        events.push('lock');
        return 'approved';
      },
      async claimDispatchLease(_tx: unknown, _t: unknown, _b: unknown, ttlMs: number) {
        events.push(`claim:${ttlMs}`);
        return opts.claim === undefined ? TOKEN : opts.claim;
      },
      async checkDispatchLease(_tx: unknown, _t: unknown, _b: unknown, lease: unknown, headroomMs: number) {
        if (opts.checkThrows === true) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        const answer = checks[Math.min(checkIndex, checks.length - 1)]!;
        checkIndex += 1;
        events.push(`check:${headroomMs}:${answer}`);
        expect(lease).toBe(TOKEN);
        return answer;
      },
      async releaseDispatchLease(_tx: unknown, _t: unknown, _b: unknown, lease: unknown) {
        events.push('release');
        releases.push(lease);
        if (opts.releaseThrows === true) throw new Error('57P01 terminating connection');
        return true;
      },
      async findByIdInTx() {
        return broadcast;
      },
      async findById() {
        if (attachAttempted) {
          events.push('readBack');
          if (opts.readBackThrows === true) throw new Error('57P01 terminating connection');
        }
        return broadcast;
      },
      async attachAudienceId(_tx: unknown, _t: unknown, _b: unknown, id: string, lease: unknown) {
        write('attachAudienceId', lease);
        attachAttempted = true;
        if (opts.attachLandsBeforeFault === true) broadcast.resendAudienceId = id;
        if (opts.attachAudienceIdThrows === 'lease_lost') throw leaseLost();
        if (opts.attachAudienceIdThrows === 'db_fault') throw new Error('08006 connection failure');
        if (opts.attachAudienceIdThrows === 'conflict') {
          throw new (BroadcastConcurrentMutationError as unknown as new (...a: unknown[]) => Error)(tenant.slug, BROADCAST_ID, 'cancelled');
        }
      },
      async attachAudienceImport(_tx: unknown, _t: unknown, _b: unknown, _id: string, lease: unknown) {
        write('attachAudienceImport', lease);
      },
      async attachBroadcastId(_tx: unknown, _t: unknown, _b: unknown, _id: string, lease: unknown) {
        write('attachBroadcastId', lease);
        if (opts.attachBroadcastIdThrows === 'lease_lost') throw leaseLost();
      },
      async attachResendIds(_tx: unknown, _t: unknown, _b: unknown, _a: string, _r: string, lease: unknown) {
        write('attachResendIds', lease);
        if (opts.attachResendIdsThrows === 'lease_lost') throw leaseLost();
      },
      async applyTransition(_tx: unknown, _t: unknown, _b: unknown, target: string, _f: unknown, _from: string, lease: unknown) {
        write(`applyTransition:${target}`, lease);
        if (target === 'sending' && opts.sendingTransitionThrows === 'lease_lost') throw leaseLost();
        if (target === 'failed_to_dispatch' && opts.terminalTransitionThrows === 'lease_lost') throw leaseLost();
        if (target === 'failed_to_dispatch' && opts.terminalTransitionThrows === 'conflict') {
          throw new (BroadcastConcurrentMutationError as unknown as new (...a: unknown[]) => Error)(tenant.slug, BROADCAST_ID, 'cancelled');
        }
        return { ...broadcast, status: target };
      },
      async markAudienceImportCompleted(_tx: unknown, _t: unknown, _b: unknown, lease: unknown) {
        write('markAudienceImportCompleted', lease);
        if (opts.completionStampThrows === 'lease_lost') throw leaseLost();
      },
      async markDispatchRetryStarted(_tx: unknown, _t: unknown, _b: unknown, at: Date, lease: unknown) {
        write('markDispatchRetryStarted', lease);
        return opts.retryStampReturns === undefined ? at : opts.retryStampReturns;
      },
      async clearDispatchRetryClock(_tx: unknown, _t: unknown, _b: unknown, lease: unknown) {
        write('clearDispatchRetryClock', lease);
      },
      async releaseAudienceImport(_tx: unknown, _t: unknown, _b: unknown, _e: unknown, lease: unknown) {
        write('releaseAudienceImport', lease);
        return opts.releaseImportAnswers ?? 'ok';
      },
      async releaseResendAudience(_tx: unknown, _t: unknown, _b: unknown, _e: unknown, lease: unknown) {
        write('releaseResendAudience', lease);
        return 'ok' as const;
      },
      async readAlreadySentEvidenceInTx() {
        return { broadcastRecorded: false, memberBroadcastCount: 0 };
      },
      // Spec 139 s2 - the deleted-row dedupe (no prior row here).
      async hasAudienceDeletedAuditInTx() {
        return false;
      },
    },
    broadcastsGateway: {
      async retrieveBroadcast(id: string) {
        events.push('gw:retrieveBroadcast');
        if (opts.probe === 'not_found') return { kind: 'not_found' as const };
        return { kind: 'present' as const, resource: { id, status: opts.probe ?? 'draft', sentAt: null } };
      },
      async createAudience() {
        events.push('gw:createAudience');
        if (opts.createAudienceRetryable === true) throw { kind: 'retryable', subKind: 'network', reason: 'fetch failed' };
        return { audienceId: 'aud-new' };
      },
      async createContactImport() {
        events.push('gw:createContactImport');
        return { importId: 'imp-new' };
      },
      async getContactImport() {
        events.push('gw:getContactImport');
        return {
          status: opts.importStatus ?? 'completed',
          counts: { total: RECIPIENTS.length, created: RECIPIENTS.length, updated: 0, skipped: 0, failed: 0 },
        };
      },
      async getAudienceContactCount() {
        events.push('gw:getAudienceContactCount');
        return { count: RECIPIENTS.length, complete: true };
      },
      async createBroadcast() {
        events.push('gw:createBroadcast');
        return { broadcastId: 'rb-minted' };
      },
      async sendBroadcast() {
        events.push('gw:sendBroadcast');
      },
      async deleteBroadcast(id: string) {
        events.push(`gw:deleteBroadcast:${id}`);
      },
      async deleteAudience(id: string) {
        events.push(`gw:deleteAudience:${id}`);
        if (opts.deleteAudienceThrows === true) throw { kind: 'retryable', subKind: 'timeout', reason: 'aborted' };
      },
      async deleteBroadcastOnce(id: string) {
        events.push(`gw:deleteBroadcastOnce:${id}`);
        return { kind: 'deleted' as const };
      },
      async retrieveBroadcastOnce() {
        events.push('gw:retrieveBroadcastOnce');
        return { kind: 'not_found' as const };
      },
    },
    // Spec 142 review round 3 (code-review #1) — the restart writes its
    // deleted row through `emitOnce`; `TickHarnessDeps` makes a double without it a
    // type error instead of a silent lost row.
    audit: {
      async emit() {},
      async emitOnce(_tx: unknown, e: AudienceDeletedEmitInput) {
        deletedRows.push({ eventType: e.eventType, payload: { ...e.payload } });
        return true;
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
  const gatewayCalls = () => events.filter((e) => e.startsWith('gw:'));
  return { run, events, writeLeases, releases, memberEmails, deletedRows, gatewayCalls };
}

const TICK2_ROW = { resendAudienceId: 'aud-1', audienceImportId: 'imp-1', audienceImportSubmittedAt: new Date(NOW.getTime() - 600_000) };

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

const logged = (spy: ReturnType<typeof vi.spyOn>, event: string) => spy.mock.calls.some((c) => c[1] === event);

/**
 * Spec 142 review round 3 (code-review #1) — a restart that reached the
 * audience step wrote its deleted row (once per run, for `audienceId`), and
 * nothing went down the lost-row branch. A double without `emitOnce` threw a
 * TypeError there, which the helper logs and swallows, so the cells stayed
 * green.
 */
const expectDeletedRowWritten = (h: { deletedRows: ReadonlyArray<{ eventType: string; payload: Record<string, unknown> }> }, audienceId: string) => {
  expect(h.deletedRows).toEqual([
    { eventType: 'broadcast_audience_deleted', payload: expect.objectContaining({ resend_audience_id: audienceId }) },
  ]);
  expect(logged(error, 'broadcasts.audience_import.audience_audit_lost')).toBe(false);
};

describe('spec 140 s2b — buildAudienceTick under the dispatch lease', () => {
  it('claims in the step-1 lock tx, after the row lock, for LEASE_TTL_MS', async () => {
    const h = harness();
    await h.run();
    expect(h.events.slice(0, 2)).toEqual(['lock', `claim:${LEASE_TTL_MS}`]);
  });

  it('row 3 — a held lease (the claim answers null) skips with NO gateway call and NO write', async () => {
    const h = harness({ claim: null });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'held_by_another_tick' });
    expect(h.gatewayCalls()).toEqual([]);
    expect(h.writeLeases).toEqual([]);
    expect(h.releases).toEqual([]);
    expect(logged(info, 'broadcasts.audience_import.lease_held')).toBe(true);
  });

  it('row 5 — tick 1: a held check precedes createAudience (C + M) and the import POST (I + M); every write carries the token', async () => {
    const h = harness();
    const res = await h.run();
    expect(res.ok ? res.value.kind : res.error).toBe('import_submitted');
    const order = h.events.filter((e) => e.startsWith('gw:') || e.startsWith('check:'));
    expect(order).toEqual([
      `check:${CALL_HEADROOM_MS}:held`,
      'gw:createAudience',
      `check:${IMPORT_HEADROOM_MS}:held`,
      'gw:createContactImport',
    ]);
    expect(h.writeLeases.length).toBeGreaterThan(0);
    for (const w of h.writeLeases) expect(w, w.method).toEqual({ method: w.method, lease: TOKEN });
  });

  it('row 5 — tick 2: a held check precedes createBroadcast and sendBroadcast; the post-send writes carry the token', async () => {
    const h = harness({ row: TICK2_ROW });
    const res = await h.run();
    expect(res.ok ? res.value.kind : res.error).toBe('sent');
    const order = h.events.filter((e) => e.startsWith('gw:create') || e.startsWith('gw:send') || e.startsWith('check:'));
    expect(order).toEqual([`check:${CALL_HEADROOM_MS}:held`, 'gw:createBroadcast', `check:${CALL_HEADROOM_MS}:held`, 'gw:sendBroadcast']);
    for (const w of h.writeLeases) expect(w, w.method).toEqual({ method: w.method, lease: TOKEN });
    expect(h.writeLeases.map((w) => w.method)).toEqual(
      expect.arrayContaining(['attachBroadcastId', 'attachResendIds', 'applyTransition:sending', 'markAudienceImportCompleted']),
    );
  });

  // Review round 1 (CR#4) — a lease expiring on its own holder is a budget
  // breach, not a concurrent skip: its own kind, logged at WARN.
  it('row 6 — within C + M of expiry no call is made: the lease_expiring kind, WARN, and the lease is still released', async () => {
    const h = harness({ checks: ['expiring'] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'lease_expiring', step: 'createAudience' });
    expect(h.gatewayCalls()).toEqual([]);
    expect(logged(warn, 'broadcasts.audience_import.lease_expiring')).toBe(true);
    expect(h.releases).toEqual([TOKEN]);
  });

  // Review round 1 (reliability L2) — a check that times out on the row lock
  // (`CHECK_LOCK_TIMEOUT_MS`) is `lease_check_failed`: retryable, no call.
  it('a pre-call check that throws (its lock_timeout) is lease_check_failed: phase lease, no Resend call', async () => {
    const h = harness({ checkThrows: true });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject({ kind: 'dispatch.server_error', message: 'lease_check_failed', phase: 'lease' });
    expect(h.gatewayCalls()).toEqual([]);
    expect(logged(warn, 'broadcasts.audience_import.lease_check_failed')).toBe(true);
    expect(h.releases).toEqual([TOKEN]);
  });

  it('the import POST demands I + M: a lease good for C + M but not I + M makes no import', async () => {
    const h = harness({ checks: ['held', 'expiring'] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'lease_expiring', step: 'createContactImport' });
    expect(h.gatewayCalls()).toEqual(['gw:createAudience']);
    expect(h.events).toContain(`check:${IMPORT_HEADROOM_MS}:expiring`);
  });

  it('DL2 — an expired holder makes no Resend call after the expiry: the check before /send reads lost, nothing is sent', async () => {
    const h = harness({ row: TICK2_ROW, checks: ['held', 'lost'] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    expect(h.gatewayCalls()).not.toContain('gw:sendBroadcast');
    expect(h.writeLeases.map((w) => w.method)).not.toContain('applyTransition:sending');
    expect(logged(info, 'broadcasts.audience_import.lease_lost')).toBe(true);
  });

  // Review round 2 (code-review #1) — the audience twin of A2: an audience
  // this tick just created is on no row once its attach loses the lease, so
  // no tick can be using it; it is deleted with NO pre-call check. An
  // undecided delete is the leak an operator must see.
  it('a lost lease at attachAudienceId deletes the audience it just created (no lease check first)', async () => {
    const h = harness({ attachAudienceIdThrows: 'lease_lost' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    const afterCreate = h.events.slice(h.events.indexOf('gw:createAudience') + 1);
    expect(afterCreate.filter((e) => e.startsWith('gw:') || e.startsWith('check:'))).toEqual(['gw:deleteAudience:aud-new']);
    expect(h.gatewayCalls()).not.toContain('gw:createContactImport');
  });

  it('an undecided delete of that audience logs audience_leaked at ERROR with the id', async () => {
    const h = harness({ attachAudienceIdThrows: 'lease_lost', deleteAudienceThrows: true });
    await h.run();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ resendAudienceId: 'aud-new' }),
      'broadcasts.audience_import.audience_leaked',
    );
  });

  // Review round 3 (code-review #1) — any other failed attach: the row is read
  // back (the `_persist-minted-broadcast-id.ts` pattern). The id on the row →
  // the write committed, keep the audience; not on the row → delete it; a
  // read-back that fails keeps it and logs audience_leaked.
  it.each([
    ['a DB fault', 'db_fault' as const],
    ['a status-drift refusal', 'conflict' as const],
  ])('%s at attachAudienceId whose read-back shows no id deletes the audience', async (_label, throws) => {
    const h = harness({ attachAudienceIdThrows: throws });
    await h.run().catch(() => undefined);
    const afterCreate = h.events.slice(h.events.indexOf('gw:createAudience') + 1);
    expect(afterCreate.filter((e) => e.startsWith('gw:') || e === 'readBack')).toEqual(['readBack', 'gw:deleteAudience:aud-new']);
    expect(logged(info, 'broadcasts.audience_import.audience_reclaimed')).toBe(true);
  });

  it('a DB fault at attachAudienceId whose read-back shows the id keeps it', async () => {
    const h = harness({ attachAudienceIdThrows: 'db_fault', attachLandsBeforeFault: true });
    await h.run().catch(() => undefined);
    expect(h.events).toContain('readBack');
    expect(h.gatewayCalls()).not.toContain('gw:deleteAudience:aud-new');
    expect(logged(warn, 'broadcasts.audience_import.attach_ack_lost_audience_kept')).toBe(true);
  });

  it('a read-back that fails keeps the audience and logs audience_leaked at ERROR with the id', async () => {
    const h = harness({ attachAudienceIdThrows: 'db_fault', readBackThrows: true });
    await h.run().catch(() => undefined);
    expect(h.gatewayCalls()).not.toContain('gw:deleteAudience:aud-new');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ resendAudienceId: 'aud-new', step: 'read_back' }),
      'broadcasts.audience_import.audience_leaked',
    );
  });

  // Review round 4 (reliability LOW-3) — a DB blip at the attach is the
  // transient answer, not a thrown `uncaught_error` (which pages as a bug):
  // `dispatch.server_error`, phase `attach_audience`, after the reclaim.
  it('a DB fault at attachAudienceId answers dispatch.server_error after the reclaim', async () => {
    const h = harness({ attachAudienceIdThrows: 'db_fault' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toMatchObject({ kind: 'dispatch.server_error', phase: 'attach_audience', errClass: 'Error' });
    const afterCreate = h.events.slice(h.events.indexOf('gw:createAudience') + 1);
    expect(afterCreate.filter((e) => e.startsWith('gw:') || e === 'readBack')).toEqual(['readBack', 'gw:deleteAudience:aud-new']);
    expect(h.releases).toEqual([TOKEN]);
  });

  it('row 8 — a lost-token attach after the mint is a concurrent skip; the mint is reclaimed with NO lease check (A2)', async () => {
    const h = harness({ row: TICK2_ROW, attachBroadcastIdThrows: 'lease_lost' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    const afterMint = h.events.slice(h.events.indexOf('gw:createBroadcast') + 1);
    // The reclaim follows the refused attach directly — no check in between.
    expect(afterMint.filter((e) => e.startsWith('check:') || e.startsWith('gw:'))).toEqual(['gw:deleteBroadcast:rb-minted']);
    expect(h.gatewayCalls()).not.toContain('gw:sendBroadcast');
  });

  it('row 9 — a lost lease never writes failed_to_dispatch: no member email, a concurrent skip, not cleanup_failed', async () => {
    const h = harness({ row: TICK2_ROW, importStatus: 'failed', terminalTransitionThrows: 'lease_lost' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    expect(h.memberEmails).toEqual([]);
    expect(logged(error, 'broadcasts.audience_import.cleanup_failed')).toBe(false);
    expect(h.releases).toEqual([TOKEN]);
  });

  // Review round 1 (security L2, reliability L3) — the ERROR `failed` line is
  // written only once the terminal write committed; a lost lease logs only
  // `lease_lost`.
  it('row 9 — a lost lease at the terminal write logs only lease_lost, never the ERROR failed line', async () => {
    const h = harness({ row: TICK2_ROW, importStatus: 'failed', terminalTransitionThrows: 'lease_lost' });
    await h.run();
    expect(logged(error, 'broadcasts.audience_import.failed')).toBe(false);
    expect(logged(info, 'broadcasts.audience_import.lease_lost')).toBe(true);
  });

  it('a terminal write that commits still logs the ERROR failed line (after the commit)', async () => {
    const h = harness({ row: TICK2_ROW, importStatus: 'failed' });
    await h.run();
    expect(logged(error, 'broadcasts.audience_import.failed')).toBe(true);
    expect(h.writeLeases.map((w) => w.method)).toContain('applyTransition:failed_to_dispatch');
  });

  // Review round 1 (security I5) — a retryable failure whose retry-clock stamp
  // matched no row: under the lease that is a lost token, so it is labelled so.
  it('onRetryable with a lost token is labelled lease_lost', async () => {
    const h = harness({ createAudienceRetryable: true, retryStampReturns: null });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
  });

  it('row 9 on the resolver path — a lost lease at the too_large terminal write is a skip, not broadcast_audience_too_large', async () => {
    const h = harness({ resolveTooLarge: true, terminalTransitionThrows: 'lease_lost' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    expect(h.memberEmails).toEqual([]);
  });

  it('the stale-audience restart checks the lease before EACH delete (CAS 12), and a lost lease deletes nothing more', async () => {
    const h = harness({ row: { resendAudienceId: 'aud-stale', resendBroadcastId: 'rb-dead' }, probe: 'draft' });
    await h.run();
    const order = h.events.filter((e) => e.startsWith('gw:delete') || e.startsWith('check:'));
    expect(order).toEqual([
      `check:${CALL_HEADROOM_MS}:held`,
      'gw:deleteBroadcast:rb-dead',
      `check:${CALL_HEADROOM_MS}:held`,
      'gw:deleteAudience:aud-stale',
    ]);

    const expiring = harness({ row: { resendAudienceId: 'aud-stale', resendBroadcastId: 'rb-dead' }, probe: 'draft', checks: ['held', 'expiring'] });
    const expiringRes = await expiring.run();
    expect(expiringRes.ok ? expiringRes.value : expiringRes.error).toEqual({ kind: 'lease_expiring', step: 'delete_audience' });

    const lost = harness({ row: { resendAudienceId: 'aud-stale', resendBroadcastId: 'rb-dead' }, probe: 'draft', checks: ['held', 'lost'] });
    await lost.run();
    expect(lost.gatewayCalls()).not.toContain('gw:deleteAudience:aud-stale');
    expect(lost.writeLeases.map((w) => w.method)).not.toContain('releaseResendAudience');
    // The row is written before the audience step's lease check, so all three runs wrote it.
    for (const run of [h, expiring, lost]) expectDeletedRowWritten(run, 'aud-stale');
  });

  it('the standing gate deletes the row\'s draft only after a held check (A8); a lost lease deletes nothing and is a skip', async () => {
    const h = harness({ row: { ...TICK2_ROW, resendBroadcastId: 'rb-draft' }, standing: { halted: ['m-1'], haltReadFresh: { halted: ['m-1'] } } });
    await h.run();
    const order = h.events.filter((e) => e.startsWith('gw:deleteBroadcastOnce') || e.startsWith('check:'));
    expect(order).toEqual([`check:${CALL_HEADROOM_MS}:held`, 'gw:deleteBroadcastOnce:rb-draft']);

    const lost = harness({
      row: { ...TICK2_ROW, resendBroadcastId: 'rb-draft' },
      standing: { halted: ['m-1'], haltReadFresh: { halted: ['m-1'] } },
      checks: ['lost'],
    });
    const res = await lost.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    expect(lost.gatewayCalls().some((e) => e.startsWith('gw:deleteBroadcastOnce'))).toBe(false);
    expect(lost.writeLeases.map((w) => w.method)).not.toContain('applyTransition:failed_to_dispatch');
  });

  // Review round 3 (reliability LOW-B) — an `approved` row after `/send` has
  // no remaining cause (no live holder can be taken over inside the TTL), so
  // it is still not the critical line, but it is WARN, not INFO.
  it('A4 — a lease lost after /send (the ids attach) on an approved row logs lease_lost_after_send at WARN, not sent_but_transition_lost', async () => {
    const h = harness({ row: TICK2_ROW, attachResendIdsThrows: 'lease_lost', lostRowStatus: 'approved' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost', rowStatus: 'approved' });
    expect(h.gatewayCalls()).toContain('gw:sendBroadcast');
    expect(logged(warn, 'broadcasts.audience_import.lease_lost_after_send')).toBe(true);
    expect(logged(info, 'broadcasts.audience_import.lease_lost_after_send')).toBe(false);
    expect(logged(error, 'broadcasts.audience_import.sent_but_transition_lost')).toBe(false);
  });

  it('A4 — the same for a lease lost at the sending transition', async () => {
    const h = harness({ row: TICK2_ROW, sendingTransitionThrows: 'lease_lost', lostRowStatus: 'sending' });
    await h.run();
    expect(logged(info, 'broadcasts.audience_import.lease_lost_after_send')).toBe(true);
    expect(logged(error, 'broadcasts.audience_import.sent_but_transition_lost')).toBe(false);
  });

  // Review round 1 (CR#1, security M1, reliability M1) — `lease_lost` carries
  // the row status the repo probed. After `/send`, only `approved` (a
  // takeover) or `sending` (a sibling flipped it) is benign; a row a cancel
  // took to `cancelled` after the mail went out still needs a human.
  it.each([
    ['attach_ids', { attachResendIdsThrows: 'lease_lost' as const }],
    ['sending_transition', { sendingTransitionThrows: 'lease_lost' as const }],
  ])('a lease cleared by a cancel after /send still logs sent_but_transition_lost (%s)', async (_step, throws) => {
    const h = harness({ row: TICK2_ROW, ...throws, lostRowStatus: 'cancelled' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost', rowStatus: 'cancelled' });
    expect(logged(error, 'broadcasts.audience_import.sent_but_transition_lost')).toBe(true);
    expect(logged(info, 'broadcasts.audience_import.lease_lost_after_send')).toBe(false);
  });

  it.each([
    ['attach_ids', { attachResendIdsThrows: 'lease_lost' as const }, 'approved'],
    ['sending_transition', { sendingTransitionThrows: 'lease_lost' as const }, 'cancelled'],
  ])('both A4 arms count broadcasts_dispatch_lease_lost_after_send_total{step} (%s)', async (step, throws, rowStatus) => {
    const counted = vi.spyOn(broadcastsMetrics, 'dispatchLeaseLostAfterSend').mockImplementation(() => undefined);
    const h = harness({ row: TICK2_ROW, ...throws, lostRowStatus: rowStatus });
    await h.run();
    expect(counted).toHaveBeenCalledWith('test-tenant', step);
  });

  // Spec L4 — the completion-stamp A4 site. Review round 3 (spec F2): the
  // stamp runs after the `sending` transition, and every SENDING_STARTED
  // status passes its fence, so the one status it can reach without the token
  // is `failed_to_dispatch` — `reconcile-stuck-sending` failing a row stuck in
  // `sending` for more than 24 h, which clears the lease. That is critical.
  it('A4 — a lease lost at the completion stamp on a failed_to_dispatch row logs completion_stamp_failed and counts it; the tick still reports sent', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'dispatchLeaseLostAfterSend').mockImplementation(() => undefined);
    const h = harness({ row: TICK2_ROW, completionStampThrows: 'lease_lost', lostRowStatus: 'failed_to_dispatch' });
    const res = await h.run();
    expect(res.ok ? res.value.kind : res.error).toBe('sent');
    expect(logged(error, 'broadcasts.audience_import.completion_stamp_failed')).toBe(true);
    expect(logged(info, 'broadcasts.audience_import.lease_lost_after_send')).toBe(false);
    expect(counted).toHaveBeenCalledWith('test-tenant', 'completion_stamp');
  });

  // A dead-arm pin: the stamp cannot meet an `approved` row (it runs after the
  // `sending` transition). If it ever did, the answer is the WARN line, counted.
  it('dead-arm pin — a lease lost at the completion stamp on an approved row is the WARN line, counted', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'dispatchLeaseLostAfterSend').mockImplementation(() => undefined);
    const h = harness({ row: TICK2_ROW, completionStampThrows: 'lease_lost', lostRowStatus: 'approved' });
    const res = await h.run();
    expect(res.ok ? res.value.kind : res.error).toBe('sent');
    expect(logged(warn, 'broadcasts.audience_import.lease_lost_after_send')).toBe(true);
    expect(logged(error, 'broadcasts.audience_import.completion_stamp_failed')).toBe(false);
    expect(counted).toHaveBeenCalledWith('test-tenant', 'completion_stamp');
  });

  // Review round 2 (CR#3) — the hold's restart is best-effort, but a lease
  // that ran short or was lost while it ran is the tick's answer, not a hold.
  it.each([
    ['expiring', { kind: 'lease_expiring', step: 'delete_audience' }],
    ['lost', { kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' }],
  ] as const)('the hold arm passes the restart’s %s lease through', async (answer, expected) => {
    const held = vi.spyOn(broadcastsMetrics, 'dispatchStandingHeldTotal').mockImplementation(() => undefined);
    const h = harness({ row: { resendAudienceId: 'aud-held' }, standing: { access: 'suspended' }, checks: [answer] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual(expected);
    expect(h.gatewayCalls()).not.toContain('gw:deleteAudience:aud-held');
    // Review round 3 (CR#4) — not a hold: nothing recorded, the clock untouched.
    expect(held).not.toHaveBeenCalled();
    expect(logged(info, 'broadcasts.dispatch.standing_held')).toBe(false);
    expect(h.writeLeases.map((w) => w.method)).not.toContain('clearDispatchRetryClock');
    // The row is written before the lease check that stops the delete.
    expectDeletedRowWritten(h, 'aud-held');
  });

  it('the hold arm still answers dispatch_held_member_suspended when its restart completes', async () => {
    const held = vi.spyOn(broadcastsMetrics, 'dispatchStandingHeldTotal').mockImplementation(() => undefined);
    const h = harness({ row: { resendAudienceId: 'aud-held' }, standing: { access: 'suspended' } });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'dispatch_held_member_suspended' });
    expect(h.gatewayCalls()).toContain('gw:deleteAudience:aud-held');
    // Review round 3 (CR#4) — the hold is recorded and the clock reset AFTER the restart.
    expect(held).toHaveBeenCalledTimes(1);
    const writes = h.events.filter((e) => e.startsWith('write:'));
    expect(writes.indexOf('write:clearDispatchRetryClock')).toBeGreaterThan(writes.indexOf('write:releaseResendAudience'));
    expectDeletedRowWritten(h, 'aud-held');
  });

  // Review round 4 (code-review #4) — a 0-row release CAS probes the token,
  // so the restart answers the REAL cause: a cleared token is lease_lost, an
  // id that moved is cas_lost (unknown_or_already_processed). Not a hold.
  it.each([
    ['lease_lost' as const, { kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' }],
    ['cas_lost' as const, { kind: 'broadcast_invalid_state_transition', observedStatus: 'unknown_or_already_processed' }],
  ])('a hold whose release CAS answers %s answers that cause and deletes nothing', async (answer, expected) => {
    const held = vi.spyOn(broadcastsMetrics, 'dispatchStandingHeldTotal').mockImplementation(() => undefined);
    const h = harness({ row: TICK2_ROW, standing: { access: 'suspended' }, releaseImportAnswers: answer });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual(expected);
    expect(h.gatewayCalls().filter((e) => e.startsWith('gw:delete'))).toEqual([]);
    expect(held).not.toHaveBeenCalled();
  });

  // Review round 2 (spec L-g) — a self-heal restart that lost the lease says so.
  it('a self-heal restart that loses the lease answers lease_lost, not unknown_or_already_processed', async () => {
    const h = harness({ row: { resendAudienceId: 'aud-stale', resendBroadcastId: 'rb-dead' }, probe: 'draft', checks: ['held', 'lost'] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    expectDeletedRowWritten(h, 'aud-stale');
  });

  // Review round 2 (reliability NIT) — the ERROR line names what failed and where the row was.
  it('cleanup_failed carries errorKind, importId and the expected and observed statuses', async () => {
    const h = harness({ row: TICK2_ROW, importStatus: 'failed', terminalTransitionThrows: 'conflict' });
    await h.run();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: 'audience_import_failed', importId: 'imp-1', expectedStatus: 'approved', observedStatus: 'cancelled' }),
      'broadcasts.audience_import.cleanup_failed',
    );
  });

  it('releases the lease in a finally, once, on success; a failed release is logged and changes nothing', async () => {
    const h = harness();
    await h.run();
    expect(h.releases).toEqual([TOKEN]);
    expect(h.events.at(-1)).toBe('release');

    const broken = harness({ releaseThrows: true });
    const res = await broken.run();
    expect(res.ok ? res.value.kind : res.error).toBe('import_submitted');
    expect(logged(warn, 'broadcasts.audience_import.lease_release_failed')).toBe(true);
  });

  it('DL9 — no row starts after the cutoff: nothing is locked, claimed or called', async () => {
    const h = harness({ tickStartedAt: NOW.getTime() - ROW_START_CUTOFF_MS - 1 });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'deferred_past_cutoff' });
    expect(h.events).toEqual([]);

    const atCutoff = harness({ tickStartedAt: NOW.getTime() - ROW_START_CUTOFF_MS });
    await atCutoff.run();
    expect(atCutoff.events[0]).toBe('lock');
  });
});
