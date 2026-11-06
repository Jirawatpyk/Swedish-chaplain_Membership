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
import { buildAudienceTick, type BuildAudienceTickDeps } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import { AuditPortInvariantError } from '@/modules/broadcasts/application/ports/audit-port';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { makeFakeSendStanding, type FakeSendStandingOpts } from '../../../helpers/eblast-approval-fakes';

const tenant = asTenantContext('test-tenant');
const BROADCAST_ID = asBroadcastId('66666666-6666-4666-8666-666666666666');
const NOW = new Date('2026-11-06T03:00:00Z');
const RECIPIENTS = ['a@example.com', 'b@example.com', 'c@example.com'];
const TOKEN = 'bbbbbbbb-0000-4000-8000-00000000000b';
/** `_dispatch-lease.ts`'s values, spelled here so a drift there is a red test. */
const CALL_HEADROOM_MS = 25_000;
const IMPORT_HEADROOM_MS = 45_000;

type DepsWithEveryPort = { [K in keyof BuildAudienceTickDeps]: unknown };

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
  const deps: DepsWithEveryPort = {
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
      // The dedupe, read over what this recorder holds (a second tick is
      // seeded with the first tick's rows through `priorAudits`).
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
