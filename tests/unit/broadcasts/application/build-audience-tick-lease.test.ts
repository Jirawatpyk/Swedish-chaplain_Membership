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
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick, type BuildAudienceTickDeps } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { makeFakeSendStanding, type FakeSendStandingOpts } from '../../../helpers/eblast-approval-fakes';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('55555555-5555-4555-8555-555555555555');
const NOW = new Date('2026-11-01T03:00:00Z');
const RECIPIENTS = ['a@example.com', 'b@example.com'];
const TOKEN = 'aaaaaaaa-0000-4000-8000-00000000000a';
/** The values `_dispatch-lease.ts` exports, spelled here so a drift there is a red test, not a moved goalpost. */
const CALL_HEADROOM_MS = 25_000;
const IMPORT_HEADROOM_MS = 45_000;
const LEASE_TTL_MS = 330_000;
const ROW_START_CUTOFF_MS = 131_000;

type DepsWithEveryPort = { [K in keyof BuildAudienceTickDeps]: unknown };

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
  readonly terminalTransitionThrows?: 'lease_lost';
  readonly releaseThrows?: boolean;
  readonly importStatus?: string;
  readonly standing?: FakeSendStandingOpts;
  readonly probe?: 'draft' | 'not_found';
  readonly tickStartedAt?: number;
  /** The resolver refuses: the audience grew past the ceiling. */
  readonly resolveTooLarge?: boolean;
}

function harness(opts: Opts = {}) {
  const events: string[] = [];
  const writeLeases: Array<{ method: string; lease: unknown }> = [];
  const releases: unknown[] = [];
  const memberEmails: unknown[] = [];
  let checkIndex = 0;
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
  const leaseLost = () => new BroadcastConcurrentMutationError(tenant.slug, BROADCAST_ID, 'lease_lost');
  const write = (method: string, lease: unknown) => {
    events.push(`write:${method}`);
    writeLeases.push({ method, lease });
  };
  const deps: DepsWithEveryPort = {
    tenant,
    clock: { now: () => NOW },
    tickBudget: { tickStartedAt: opts.tickStartedAt ?? NOW.getTime(), maxDurationMs: 300_000 },
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
        events.push('lock');
        return 'approved';
      },
      async claimDispatchLease(_tx: unknown, _t: unknown, _b: unknown, ttlMs: number) {
        events.push(`claim:${ttlMs}`);
        return opts.claim === undefined ? TOKEN : opts.claim;
      },
      async checkDispatchLease(_tx: unknown, _t: unknown, _b: unknown, lease: unknown, headroomMs: number) {
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
        return broadcast;
      },
      async attachAudienceId(_tx: unknown, _t: unknown, _b: unknown, _id: string, lease: unknown) {
        write('attachAudienceId', lease);
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
        return { ...broadcast, status: target };
      },
      async markAudienceImportCompleted(_tx: unknown, _t: unknown, _b: unknown, lease: unknown) {
        write('markAudienceImportCompleted', lease);
      },
      async markDispatchRetryStarted(_tx: unknown, _t: unknown, _b: unknown, at: Date, lease: unknown) {
        write('markDispatchRetryStarted', lease);
        return at;
      },
      async clearDispatchRetryClock(_tx: unknown, _t: unknown, _b: unknown, lease: unknown) {
        write('clearDispatchRetryClock', lease);
      },
      async releaseAudienceImport(_tx: unknown, _t: unknown, _b: unknown, _e: unknown, lease: unknown) {
        write('releaseAudienceImport', lease);
        return true;
      },
      async releaseResendAudience(_tx: unknown, _t: unknown, _b: unknown, _e: unknown, lease: unknown) {
        write('releaseResendAudience', lease);
        return true;
      },
      async readAlreadySentEvidenceInTx() {
        return { broadcastRecorded: false, memberBroadcastCount: 0 };
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
    audit: { async emit() {} },
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
  return { run, events, writeLeases, releases, memberEmails, gatewayCalls };
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

describe('spec 140 s2b — buildAudienceTick under the dispatch lease', () => {
  it('claims in the step-1 lock tx, after the row lock, for LEASE_TTL_MS', async () => {
    const h = harness();
    await h.run();
    expect(h.events.slice(0, 2)).toEqual(['lock', `claim:${LEASE_TTL_MS}`]);
  });

  it('row 3 — a held lease (the claim answers null) skips with NO gateway call and NO write', async () => {
    const h = harness({ claim: null });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_held' });
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

  it('row 6 — within C + M of expiry no call is made: lease_expiring, and the lease is still released', async () => {
    const h = harness({ checks: ['expiring'] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_expiring' });
    expect(h.gatewayCalls()).toEqual([]);
    expect(logged(info, 'broadcasts.audience_import.lease_expiring')).toBe(true);
    expect(h.releases).toEqual([TOKEN]);
  });

  it('the import POST demands I + M: a lease good for C + M but not I + M makes no import', async () => {
    const h = harness({ checks: ['held', 'expiring'] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_expiring' });
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

    const lost = harness({ row: { resendAudienceId: 'aud-stale', resendBroadcastId: 'rb-dead' }, probe: 'draft', checks: ['held', 'lost'] });
    await lost.run();
    expect(lost.gatewayCalls()).not.toContain('gw:deleteAudience:aud-stale');
    expect(lost.writeLeases.map((w) => w.method)).not.toContain('releaseResendAudience');
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

  it('A4 — a lease lost after /send (the ids attach) logs lease_lost_after_send at INFO, not sent_but_transition_lost', async () => {
    const h = harness({ row: TICK2_ROW, attachResendIdsThrows: 'lease_lost' });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    expect(h.gatewayCalls()).toContain('gw:sendBroadcast');
    expect(logged(info, 'broadcasts.audience_import.lease_lost_after_send')).toBe(true);
    expect(logged(error, 'broadcasts.audience_import.sent_but_transition_lost')).toBe(false);
  });

  it('A4 — the same for a lease lost at the sending transition', async () => {
    const h = harness({ row: TICK2_ROW, sendingTransitionThrows: 'lease_lost' });
    await h.run();
    expect(logged(info, 'broadcasts.audience_import.lease_lost_after_send')).toBe(true);
    expect(logged(error, 'broadcasts.audience_import.sent_but_transition_lost')).toBe(false);
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
