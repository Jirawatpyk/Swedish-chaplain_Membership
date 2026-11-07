/**
 * Spec 139 slice 2 (DA1–DA3) — the import tick's Art. 30 rows.
 *
 * `broadcast_audience_disclosed` is written on tick 1 after the segment id is
 * attached to the row and BEFORE the import's lease gate and
 * `createContactImport`; `broadcast_audience_deleted` is written by the restart
 * teardown before its `delete_audience` lease gate. Both are written before the
 * Resend call (the broadcasts rule "Gates and audit rows for Resend calls"), so
 * each records a request, not its outcome. A storage failure is logged at
 * error level and counted, and the call proceeds; an adapter invariant error
 * rethrows before the call.
 *
 * The harness records ONE ordered event list (lease checks with their headroom,
 * repo writes, audit rows, gateway calls), so "written before the call" is an
 * ordering assertion. State table: plan.md § Slice 2 plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { AuditPortInvariantError, type AudienceDeletedEmitInput } from '@/modules/broadcasts/application/ports/audit-port';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { makeFakeSendStanding, type FakeSendStandingOpts } from '../../../helpers/eblast-approval-fakes';
import type { TickHarnessDeps } from '../../../support/broadcasts/tick-deps-type';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('66666666-6666-4666-8666-666666666666');
const NOW = new Date('2026-11-06T03:00:00Z');
const RECIPIENTS = ['a@example.com', 'b@example.com', 'c@example.com'];
const TOKEN = 'bbbbbbbb-0000-4000-8000-00000000000b';
/** `_dispatch-lease.ts`'s values, spelled here so a drift there is a red test. */
const CALL_HEADROOM_MS = 25_000;
const IMPORT_HEADROOM_MS = 45_000;

interface AuditRow {
  readonly eventType: string;
  readonly tenantId: string | null;
  readonly actorUserId: string;
  readonly payload: Record<string, unknown>;
  readonly requestId: string | null;
}

interface Opts {
  readonly row?: Partial<{
    resendAudienceId: string | null;
    audienceImportId: string | null;
    audienceImportSubmittedAt: Date | null;
    resendBroadcastId: string | null;
  }>;
  /** What each successive lease check answers; the last one repeats. Default always `held`. */
  readonly checks?: ReadonlyArray<'held' | 'lost' | 'expiring'>;
  readonly standing?: FakeSendStandingOpts;
  /** `createContactImport` throws this gateway error. */
  readonly importThrows?: { readonly kind: string; readonly code?: string; readonly subKind?: string };
  /** `createBroadcast` throws this gateway error (tick 2). */
  readonly createBroadcastThrows?: { readonly kind: string; readonly code?: string };
  /** The audit INSERT of this event type fails: a storage error, or an adapter invariant. */
  readonly auditThrows?: { readonly eventType: string; readonly kind: 'storage' | 'invariant' };
  /** `attachAudienceId` loses the lease (tick 1's reclaim of the fresh segment). */
  readonly attachLeaseLost?: boolean;
  /** Audit rows a previous tick wrote (the dedupe reads them). */
  readonly priorAudits?: readonly AuditRow[];
}

function gatewayError(e: { kind: string; code?: string | undefined; subKind?: string | undefined }): Error {
  return Object.assign(new Error('boom'), { reason: 'boom', ...e });
}

function harness(opts: Opts = {}) {
  const events: string[] = [];
  const audits: AuditRow[] = [...(opts.priorAudits ?? [])];
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
    requestedByMemberPlanIdSnapshot: 'plan-1',
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
  const deps: TickHarnessDeps = {
    tenant,
    clock: { now: () => NOW },
    tickBudget: { tickStartedAt: NOW.getTime() },
    fromEmail: 'noreply@example.com',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
    brandChrome: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
    orphans: { async recordOrphanedResendId() {} },
    resolveRecipients: async () =>
      ok({ recipients: RECIPIENTS, estimatedCount: RECIPIENTS.length, orphans: [], droppedByPreference: 0 }),
    broadcastsRepo: {
      async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn({ tx: true });
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
        return answer;
      },
      async releaseDispatchLease() {
        events.push('release');
        return true;
      },
      async findByIdInTx() {
        return broadcast;
      },
      async findById() {
        return broadcast;
      },
      async attachAudienceId(_tx: unknown, _t: unknown, _b: unknown, id: string) {
        events.push(`write:attachAudienceId:${id}`);
        if (opts.attachLeaseLost === true) {
          throw new (BroadcastConcurrentMutationError as unknown as new (...a: unknown[]) => Error)(tenant.slug, BROADCAST_ID, 'lease_lost');
        }
      },
      async attachAudienceImport() {
        events.push('write:attachAudienceImport');
      },
      async attachBroadcastId() {
        events.push('write:attachBroadcastId');
      },
      async attachResendIds() {
        events.push('write:attachResendIds');
      },
      async applyTransition(_tx: unknown, _t: unknown, _b: unknown, target: string) {
        events.push(`write:applyTransition:${target}`);
        return { ...broadcast, status: target };
      },
      async markAudienceImportCompleted() {},
      async markDispatchRetryStarted(_tx: unknown, _t: unknown, _b: unknown, at: Date) {
        return at;
      },
      async clearDispatchRetryClock() {},
      async releaseAudienceImport() {
        events.push('write:releaseAudienceImport');
        return 'ok' as const;
      },
      async releaseResendAudience() {
        events.push('write:releaseResendAudience');
        return 'ok' as const;
      },
      async readAlreadySentEvidenceInTx() {
        return { broadcastRecorded: false, memberBroadcastCount: 0 };
      },
      async hasUnverifiableCountAuditInTx() {
        return false;
      },
      // Spec 142 (AO3) — the restart no longer reads this: the index is the
      // arbiter (`emitOnce`). A read here would show up in the event order.
      async hasAudienceDeletedAuditInTx(_tx: unknown, _t: unknown, audienceId: string) {
        events.push(`dedupe:${audienceId}`);
        return audits.some(
          (a) => a.eventType === 'broadcast_audience_deleted' && a.payload['resend_audience_id'] === audienceId,
        );
      },
    },
    broadcastsGateway: {
      async retrieveBroadcast(id: string) {
        events.push('gw:retrieveBroadcast');
        return { kind: 'present' as const, resource: { id, status: 'draft', sentAt: null } };
      },
      async createAudience() {
        events.push('gw:createAudience');
        return { audienceId: 'aud-new' };
      },
      async createContactImport() {
        events.push('gw:createContactImport');
        if (opts.importThrows !== undefined) throw gatewayError(opts.importThrows);
        return { importId: 'imp-new' };
      },
      async getContactImport() {
        events.push('gw:getContactImport');
        return {
          status: 'completed',
          counts: { total: RECIPIENTS.length, created: RECIPIENTS.length, updated: 0, skipped: 0, failed: 0 },
        };
      },
      async getAudienceContactCount() {
        return { count: RECIPIENTS.length, complete: true };
      },
      async createBroadcast() {
        events.push('gw:createBroadcast');
        if (opts.createBroadcastThrows !== undefined) throw gatewayError(opts.createBroadcastThrows);
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
        return { kind: 'not_found' as const };
      },
    },
    audit: {
      async emit(_tx: unknown, e: AuditRow) {
        if (opts.auditThrows?.eventType === e.eventType) {
          events.push(`audit-failed:${e.eventType}`);
          if (opts.auditThrows.kind === 'invariant') throw new AuditPortInvariantError(e.eventType, 'unregistered event type');
          throw new Error('53300 too many connections');
        }
        events.push(`audit:${e.eventType}`);
        audits.push({ eventType: e.eventType, tenantId: e.tenantId, actorUserId: e.actorUserId, payload: e.payload, requestId: e.requestId });
      },
      // Spec 142 (AO2) — the index's answer, over what this recorder holds (a
      // second tick is seeded with the first tick's rows through `priorAudits`).
      async emitOnce(_tx: unknown, e: AudienceDeletedEmitInput): Promise<boolean> {
        if (opts.auditThrows?.eventType === e.eventType) {
          events.push(`audit-failed:${e.eventType}`);
          if (opts.auditThrows.kind === 'invariant') throw new AuditPortInvariantError(e.eventType, 'unregistered event type');
          throw new Error('53300 too many connections');
        }
        events.push(`audit-once:${e.eventType}`);
        const key = e.payload.resend_audience_id;
        if (audits.some((a) => a.eventType === e.eventType && a.tenantId === e.tenantId && a.payload['resend_audience_id'] === key)) {
          return false;
        }
        audits.push({ eventType: e.eventType, tenantId: e.tenantId, actorUserId: e.actorUserId, payload: { ...e.payload }, requestId: e.requestId ?? null });
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
    emailTransactional: { async sendMemberEmail() {} },
    plansBridge: { async getPlanForMember() { return ok({ planId: 'plan-1', planCode: 'CORP', eblastPerYear: 12 }); } },
    sendStanding: makeFakeSendStanding(opts.standing),
    pauseBeforeReprobe: async () => {},
  };
  const run = () => buildAudienceTick(deps as never, { broadcastId: BROADCAST_ID });
  const rowsOf = (eventType: string) => audits.filter((a) => a.eventType === eventType && !(opts.priorAudits ?? []).includes(a));
  return { run, events, audits, rowsOf };
}

const DISCLOSED = 'broadcast_audience_disclosed';
const DELETED = 'broadcast_audience_deleted';

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

const errorLogged = (event: string) =>
  errorSpy.mock.calls.filter((c) => c[1] === event).map((c) => c[0] as Record<string, unknown>);

describe('spec 139 s2 DA1 — tick 1 writes broadcast_audience_disclosed before the recipient list goes to Resend', () => {
  it('writes broadcast_audience_disclosed before createContactImport: after the attach, before the import gate', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const h = harness();
    const res = await h.run();
    expect(res.ok).toBe(true);
    const order = h.events.filter((e) => e.startsWith('write:attachAudienceId') || e.startsWith('audit:') || e.startsWith('check:') || e === 'gw:createContactImport');
    expect(order).toEqual([
      `check:${CALL_HEADROOM_MS}:held`,
      'write:attachAudienceId:aud-new',
      `audit:${DISCLOSED}`,
      `check:${IMPORT_HEADROOM_MS}:held`,
      'gw:createContactImport',
    ]);
    const rows = h.rowsOf(DISCLOSED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      eventType: DISCLOSED,
      tenantId: tenant.slug,
      actorUserId: 'system:cron',
      requestId: null,
      payload: {
        broadcast_id: BROADCAST_ID,
        related_member_id: 'm-1',
        resend_audience_id: 'aud-new',
        recipient_count: RECIPIENTS.length,
        leg: 'import',
        actor_role: 'system',
      },
    });
    // DA3 — ids and a count only: no address, no hash.
    expect(JSON.stringify(rows[0])).not.toContain('@');
    expect(counted).toHaveBeenCalledWith(tenant.slug, DISCLOSED);
  });

  it.each([
    ['a permanent refusal', { kind: 'permanent', code: 'validation_error' }],
    ['a 5xx', { kind: 'retryable', subKind: 'server_5xx' }],
    ['a timeout', { kind: 'retryable', subKind: 'timeout' }],
  ])('%s from the import still leaves the disclosed row (it records the request)', async (_label, importThrows) => {
    const h = harness({ importThrows });
    await h.run();
    expect(h.events).toContain('gw:createContactImport');
    expect(h.rowsOf(DISCLOSED)).toHaveLength(1);
    expect(h.events.indexOf(`audit:${DISCLOSED}`)).toBeLessThan(h.events.indexOf('gw:createContactImport'));
  });

  it('a storage failure of the disclosed row logs ERROR and counts it, and the import still goes ahead', async () => {
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness({ auditThrows: { eventType: DISCLOSED, kind: 'storage' } });
    const res = await h.run();
    expect(res.ok).toBe(true);
    expect(h.events).toContain('gw:createContactImport');
    const lines = errorLogged('broadcasts.audience_import.audience_audit_lost');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      tenantId: tenant.slug,
      broadcastId: BROADCAST_ID,
      resendAudienceId: 'aud-new',
      eventType: DISCLOSED,
      err: 'Error',
      severity: 'critical',
    });
    expect(failed).toHaveBeenCalledWith(DISCLOSED, tenant.slug);
  });

  it('an adapter invariant error is rethrown before the import: no POST, and the lease is still released', async () => {
    const h = harness({ auditThrows: { eventType: DISCLOSED, kind: 'invariant' } });
    await expect(h.run()).rejects.toBeInstanceOf(AuditPortInvariantError);
    expect(h.events).not.toContain('gw:createContactImport');
    expect(h.events.at(-1)).toBe('release');
    // Review round 2 (code-review #5) — the row helper logs the wiring bug before it rethrows.
    expect(errorLogged('broadcasts.audience_import.audit_invariant')).toEqual([
      {
        tenantId: tenant.slug,
        broadcastId: BROADCAST_ID,
        resendAudienceId: 'aud-new',
        eventType: DISCLOSED,
        err: 'AuditPortInvariantError',
        severity: 'critical',
      },
    ]);
  });

  it('an attach that fails (the fresh segment is reclaimed) writes no row: exempt, it never held recipients', async () => {
    const h = harness({ attachLeaseLost: true });
    await h.run();
    expect(h.events).toContain('gw:deleteAudience:aud-new');
    expect(h.audits.filter((a) => a.eventType === DISCLOSED || a.eventType === DELETED)).toEqual([]);
  });

  it('a lease lost at the import gate after the row: the row stays (the request), and no import is made', async () => {
    const h = harness({ checks: ['held', 'lost'] });
    const res = await h.run();
    expect(res.ok ? res.value : res.error).toEqual({ kind: 'broadcast_invalid_state_transition', observedStatus: 'lease_lost' });
    expect(h.events).not.toContain('gw:createContactImport');
    expect(h.rowsOf(DISCLOSED)).toHaveLength(1);
  });
});

const TICK2_ROW = {
  resendAudienceId: 'aud-1',
  audienceImportId: 'imp-1',
  audienceImportSubmittedAt: new Date(NOW.getTime() - 600_000),
};

describe('spec 139 s2 DA2 — the restart teardown writes broadcast_audience_deleted before its delete gate', () => {
  it.each([
    ['hold', { row: { ...TICK2_ROW, resendAudienceId: 'aud-held' }, standing: { access: 'suspended' as const } }, 'aud-held'],
    ['stale_audience', { row: { resendAudienceId: 'aud-stale' } }, 'aud-stale'],
    [
      'audience_missing',
      { row: { ...TICK2_ROW, resendAudienceId: 'aud-gone' }, createBroadcastThrows: { kind: 'permanent', code: 'not_found' } },
      'aud-gone',
    ],
  ] as const)('restart %s: the deleted row, then the delete_audience gate, then the delete', async (reason, o, audienceId) => {
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const h = harness(o);
    await h.run();
    const at = h.events.indexOf(`audit-once:${DELETED}`);
    expect(at).toBeGreaterThan(-1);
    expect(h.events.slice(at, at + 3)).toEqual([
      `audit-once:${DELETED}`,
      `check:${CALL_HEADROOM_MS}:held`,
      `gw:deleteAudience:${audienceId}`,
    ]);
    expect(h.events.filter((e) => e.startsWith('dedupe:'))).toEqual([]);
    const rows = h.rowsOf(DELETED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      eventType: DELETED,
      tenantId: tenant.slug,
      actorUserId: 'system:cron',
      requestId: null,
      payload: {
        broadcast_id: BROADCAST_ID,
        related_member_id: 'm-1',
        resend_audience_id: audienceId,
        reason,
        leg: 'import',
        actor_role: 'system',
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain('@');
    expect(counted).toHaveBeenCalledWith(tenant.slug, DELETED);
  });

  it('a second attempt on the same segment writes no second row (dedupe), and the delete still runs', async () => {
    const prior: AuditRow = {
      eventType: DELETED,
      tenantId: tenant.slug,
      actorUserId: 'system:cron',
      requestId: null,
      payload: { broadcast_id: BROADCAST_ID, related_member_id: 'm-1', resend_audience_id: 'aud-stale', reason: 'hold', leg: 'import', actor_role: 'system' },
    };
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const h = harness({ row: { resendAudienceId: 'aud-stale' }, priorAudits: [prior] });
    await h.run();
    expect(h.events).toContain(`audit-once:${DELETED}`);
    expect(h.events.filter((e) => e.startsWith('dedupe:'))).toEqual([]);
    expect(h.rowsOf(DELETED)).toEqual([]);
    expect(h.events).toContain('gw:deleteAudience:aud-stale');
    expect(counted).not.toHaveBeenCalledWith(tenant.slug, DELETED);
    expect(errorLogged('broadcasts.audience_import.audience_audit_lost')).toEqual([]);
  });

  it('the gate stops the delete: the row stays (it records the request) and no delete is made', async () => {
    const h = harness({ row: { resendAudienceId: 'aud-stale' }, checks: ['lost'] });
    await h.run();
    expect(h.rowsOf(DELETED)).toHaveLength(1);
    expect(h.events.some((e) => e.startsWith('gw:deleteAudience'))).toBe(false);
  });

  it('a lease lost at the import gate after the disclosed row: the next tick deletes that segment and records it (stale_audience)', async () => {
    const first = harness({ checks: ['held', 'lost'] });
    await first.run();
    expect(first.rowsOf(DISCLOSED)).toHaveLength(1);
    const next = harness({ row: { resendAudienceId: 'aud-new' }, priorAudits: first.audits });
    await next.run();
    expect(next.rowsOf(DELETED).map((r) => r.payload['reason'])).toEqual(['stale_audience']);
    expect(next.events).toContain('gw:deleteAudience:aud-new');
  });

  it('a storage failure of the deleted row logs ERROR and counts it, and the delete still runs', async () => {
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness({ row: { resendAudienceId: 'aud-stale' }, auditThrows: { eventType: DELETED, kind: 'storage' } });
    await h.run();
    expect(h.events).toContain('gw:deleteAudience:aud-stale');
    expect(errorLogged('broadcasts.audience_import.audience_audit_lost')).toEqual([
      expect.objectContaining({ eventType: DELETED, resendAudienceId: 'aud-stale', err: 'Error', severity: 'critical' }),
    ]);
    expect(failed).toHaveBeenCalledWith(DELETED, tenant.slug);
  });

  it('an adapter invariant error is rethrown before the delete', async () => {
    const h = harness({ row: { resendAudienceId: 'aud-stale' }, auditThrows: { eventType: DELETED, kind: 'invariant' } });
    await expect(h.run()).rejects.toBeInstanceOf(AuditPortInvariantError);
    expect(h.events.some((e) => e.startsWith('gw:deleteAudience'))).toBe(false);
    // Review round 2 (code-review #5) — the restart's line comes from the row helper too.
    expect(errorLogged('broadcasts.audience_import.audit_invariant')).toEqual([
      {
        tenantId: tenant.slug,
        broadcastId: BROADCAST_ID,
        resendAudienceId: 'aud-stale',
        eventType: DELETED,
        err: 'AuditPortInvariantError',
        severity: 'critical',
      },
    ]);
  });
});
