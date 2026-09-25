/**
 * F119 T124 · T125 (RED for T130) — the approval lifecycle: reminders, the
 * day-23 warning and the day-30 expiry (US5-AS2, US5-AS3, FR-014, FR-022,
 * FR-022a; contracts/dashboard-and-notifications.md § 5).
 *
 *   T124 — exactly one reminder per threshold across a 40-day simulated
 *          clock (injected `ClockPort`), the warning to BOTH sides, a second
 *          run the same day changes nothing, and a new version resets
 *          `member_reminder_stage` to 0 and restarts the clock.
 *   T125 — nothing is ever auto-approved, and expiry exists on exactly one
 *          `from` state: a row waiting 400 days produces exactly one expiry
 *          and zero approvals; a row parked at `member_approved` or
 *          `approved` for 400 days is untouched.
 *
 * The REAL `expireStaleMemberApprovals` — and the real send / decide / start
 * use cases for the "new version" arm — run over the in-memory approval store
 * (`withTx` is a real rollback boundary there). The scan's SQL predicate is
 * pinned against live Postgres in `eblast-allowance-bucket.test.ts` (T126).
 * The last block is the route wire: the block rides the existing
 * `prune-expired-drafts` cron, behind its `CRON_SECRET`, with its own OK flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import {
  APPROVAL_LIFECYCLE_BATCH,
  expireStaleMemberApprovals,
  type ExpireStaleMemberApprovalsDeps,
} from '@/modules/broadcasts/application/use-cases/approval/expire-stale-member-approvals';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import { sendVersionToMember } from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import { startFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalLifecycleScan,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakeMarketingDirectory,
  makeFakePortalRecipients,
  makeMarketingRecipient,
  makePortalContact,
  makeRecordingF7Audit,
  type FakeApprovalLifecycleScan,
  type FakeApprovalStore,
  type RecordingF7Audit,
} from '../../helpers/eblast-approval-fakes';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const TENANT = 'test-tenant';
const tenant = asTenantContext(TENANT);
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const V1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const DAY = 86_400_000;
/** 04:30 UTC — the cron's own hour (`30 4 * * *`, 11:30 Asia/Bangkok). */
const T0 = new Date('2026-09-01T04:30:00.000Z');
const at = (day: number, ms = 0) => new Date(T0.getTime() + day * DAY + ms);
const MARKETER = makeMarketingRecipient();

const awaitingRow = (overrides: Partial<Broadcast> = {}) =>
  makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1, stageEnteredAt: T0, memberReminderStage: 0, ...overrides });
const sentV1 = () => makeApprovalVersion({ id: V1, versionNo: 1, sentToMemberAt: T0 });

interface Harness {
  store: FakeApprovalStore;
  audit: RecordingF7Audit;
  deps: ExpireStaleMemberApprovalsDeps & { readonly lifecycleScan: FakeApprovalLifecycleScan };
  tick(day: number, ms?: number): Promise<{ scanned: number; remindersSent: number; warningsSent: number; expired: number; rowsFailed: number }>;
}

function harness(seed: { broadcasts: Broadcast[]; versions?: ReturnType<typeof makeApprovalVersion>[] }, opts: { contacts?: boolean } = {}): Harness {
  const store = makeFakeApprovalStore({ broadcasts: seed.broadcasts, versions: seed.versions ?? [sentV1()] });
  const audit = makeRecordingF7Audit();
  const deps = {
    tenant,
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    lifecycleScan: makeFakeApprovalLifecycleScan(store),
    portalRecipients: makeFakePortalRecipients(opts.contacts === false ? {} : { [MEMBER_ID]: [makePortalContact({ email: 'owner@acme.test', locale: 'th' })] }),
    marketingDirectory: makeFakeMarketingDirectory([MARKETER]),
    outbox: store.outbox,
    audit,
    clock: { now: () => store.now },
  } satisfies ExpireStaleMemberApprovalsDeps;
  return {
    store,
    audit,
    deps,
    async tick(day, ms = 0) {
      store.now = at(day, ms);
      const r = await expireStaleMemberApprovals(deps, { requestId: `tick-${day}` });
      if (!r.ok) throw new Error(`tick failed: ${r.error.kind}`);
      return r.value;
    },
  };
}

type Fired = { day: number; kind: unknown; audience: unknown; round: unknown; to: string };

/** Tick twice a day from `from` to `to`, recording every outbox row by the day it was written. */
async function run(h: Harness, from: number, to: number): Promise<Fired[]> {
  const fired: Fired[] = [];
  for (let day = from; day <= to; day += 1) {
    for (const ms of [0, 3_600_000]) {
      const before = h.store.outbox.rows().length;
      await h.tick(day, ms);
      for (const r of h.store.outbox.rows().slice(before)) {
        fired.push({ day, kind: r.contextData.kind, audience: r.contextData.audience, round: r.contextData.round, to: r.toEmail });
      }
    }
  }
  return fired;
}

const eventsOf = (audit: RecordingF7Audit, prefix = 'broadcast_approval_') => audit.events.filter((e) => e.eventType.startsWith(prefix));

beforeEach(() => vi.restoreAllMocks());

describe('T124 — exactly one reminder per threshold across a 40-day clock', () => {
  it('day 3 → one reminder_day3; day 7 → one reminder_day7; day 23 → one warning to BOTH sides; day 30 → the closure to both; twice a day changes nothing', async () => {
    const h = harness({ broadcasts: [awaitingRow()] });
    const fired = await run(h, 0, 40);
    expect(fired).toEqual([
      { day: 3, kind: 'reminder_day3', audience: 'member', round: 1, to: 'owner@acme.test' },
      { day: 7, kind: 'reminder_day7', audience: 'member', round: 1, to: 'owner@acme.test' },
      { day: 23, kind: 'expiry_warning_day23', audience: 'member', round: 1, to: 'owner@acme.test' },
      { day: 23, kind: 'expiry_warning_day23', audience: 'staff', round: 1, to: MARKETER.email },
      { day: 30, kind: 'expired_day30', audience: 'member', round: 1, to: 'owner@acme.test' },
      { day: 30, kind: 'expired_day30', audience: 'staff', round: 1, to: MARKETER.email },
    ]);
    const row = [...h.store.state.broadcasts.values()][0]!;
    expect(row).toMatchObject({ status: 'expired_no_member_response', memberReminderStage: 3, memberExpiryNotifiedAt: at(30) });
  });

  it('one audit row per E-Blast per step, actor_role system, related_member_id (never member_id), ids and counts only', async () => {
    const h = harness({ broadcasts: [awaitingRow()] });
    await run(h, 0, 40);
    const common = { related_member_id: MEMBER_ID, broadcast_id: awaitingRow().broadcastId, version_id: V1, round: 1, actor_role: 'system' };
    expect(eventsOf(h.audit).map((e) => ({ type: e.eventType, payload: e.payload, actor: e.actorUserId }))).toEqual([
      { type: 'broadcast_approval_reminder_sent', payload: { ...common, reminder: 'day3' }, actor: 'system' },
      { type: 'broadcast_approval_reminder_sent', payload: { ...common, reminder: 'day7' }, actor: 'system' },
      { type: 'broadcast_approval_expiry_warned', payload: { ...common, days_waiting: 23 }, actor: 'system' },
      { type: 'broadcast_approval_expired', payload: { ...common, days_waiting: 30, allowance_released: true }, actor: 'system' },
    ]);
    // Each audit rode the row's own transaction, as did its outbox rows.
    for (const e of eventsOf(h.audit)) expect(e.tx).toBe('fake-tx');
  });

  it('the outbox rows carry ids and discriminators only; the staff row names its roster recipient', async () => {
    const h = harness({ broadcasts: [awaitingRow()] });
    await run(h, 0, 23);
    const staff = h.store.outbox.rows().find((r) => r.contextData.audience === 'staff')!;
    expect(staff).toMatchObject({ type: 'eblast_approval_lifecycle', locale: 'en' });
    expect(staff.contextData).toEqual({ tenantId: TENANT, broadcastId: awaitingRow().broadcastId, versionId: V1, round: 1, kind: 'expiry_warning_day23', audience: 'staff', recipientUserId: MARKETER.userId });
    const member = h.store.outbox.rows().find((r) => r.contextData.audience === 'member')!;
    expect(member).toMatchObject({ locale: 'th' });
    expect(member.contextData).toEqual({ tenantId: TENANT, broadcastId: awaitingRow().broadcastId, versionId: V1, round: 1, kind: 'reminder_day3', audience: 'member' });
  });

  it('sending a new version resets member_reminder_stage to 0 and restarts the clock from the new send', async () => {
    const h = harness({ broadcasts: [awaitingRow()] });
    const early = await run(h, 0, 4);
    expect(early.map((f) => f.kind)).toEqual(['reminder_day3']);

    // Day 5: the member asks for changes; marketing opens and sends round 2.
    h.store.now = at(5);
    const actor = { actorUserId: MARKETER.userId, actorRole: 'marketing', requestId: null };
    const broadcastId = awaitingRow().broadcastId;
    const decided = await recordMemberDecision(
      { ...h.deps, decisionsRepo: h.store.decisionsRepo, marketingDirectory: makeFakeMarketingDirectory([]) },
      { broadcastId, memberId: MEMBER_ID, actorUserId: '33333333-3333-4333-8333-333333333333', actorRole: 'member', contactId: makePortalContact().contactId, versionId: V1, decision: 'changes_requested', reason: 'Move the date up', requestId: null },
    );
    expect(decided.ok).toBe(true);
    const started = await startFormattedVersion({ ...h.deps, versionsRepo: h.store.versionsRepo, memberApprovalEnabled: true }, { broadcastId, ...actor });
    expect(started.ok).toBe(true);
    const sent = await sendVersionToMember(
      { ...h.deps, versionsRepo: h.store.versionsRepo, sanitizer: dompurifySanitizer, imageAllowlist: makeFakeImageAllowlist() },
      { broadcastId, ...actor },
    );
    expect(sent.ok ? sent.value.round : sent.error).toBe(2);
    expect(h.store.state.broadcasts.get(`${TENANT}::${broadcastId}`)).toMatchObject({ memberReminderStage: 0, stageEnteredAt: at(5), currentRound: 2 });

    const later = await run(h, 5, 40);
    expect(later.map((f) => [f.day, f.kind, f.audience, f.round])).toEqual([
      [8, 'reminder_day3', 'member', 2],
      [12, 'reminder_day7', 'member', 2],
      [28, 'expiry_warning_day23', 'member', 2],
      [28, 'expiry_warning_day23', 'staff', 2],
      [35, 'expired_day30', 'member', 2],
      [35, 'expired_day30', 'staff', 2],
    ]);
  });

  it('a member with no active portal contact: the counter still advances once, no member row and no "reminder sent" audit; the day-23 warning still reaches staff', async () => {
    const h = harness({ broadcasts: [awaitingRow()] }, { contacts: false });
    const fired = await run(h, 0, 23);
    expect(fired).toEqual([{ day: 23, kind: 'expiry_warning_day23', audience: 'staff', round: 1, to: MARKETER.email }]);
    expect(eventsOf(h.audit).map((e) => e.eventType)).toEqual(['broadcast_approval_expiry_warned']);
    expect([...h.store.state.broadcasts.values()][0]!.memberReminderStage).toBe(3);
  });

  it('T166 R-L2: a day-23 warning that reaches nobody (no member contact, empty roster) still advances once, and says so in a warn — the same line as day 3 / 7', async () => {
    const h = harness({ broadcasts: [awaitingRow({ memberReminderStage: 2 })] }, { contacts: false });
    vi.mocked(h.deps.marketingDirectory.readRoster).mockResolvedValue([]);
    const { logger } = await import('@/lib/logger');
    vi.mocked(logger.warn).mockClear();
    expect(await h.tick(23)).toMatchObject({ warningsSent: 1 });
    expect(h.store.outbox.rows()).toEqual([]);
    expect(eventsOf(h.audit)).toEqual([]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ reminder: 'day23', tenantId: TENANT }),
      'M119.cron.approval_lifecycle.no_member_recipient',
    );
  });

  // F119 round-4 B8 — the closure ignored its notify count: a day-30 expiry
  // that reached nobody said nothing, unlike the day-3 / 7 / 23 steps.
  it('round-4 B8: a day-30 closure that reaches nobody (no member contact, empty roster) still closes, and says so in the same warn', async () => {
    const h = harness({ broadcasts: [awaitingRow({ memberReminderStage: 3 })] }, { contacts: false });
    vi.mocked(h.deps.marketingDirectory.readRoster).mockResolvedValue([]);
    const { logger } = await import('@/lib/logger');
    vi.mocked(logger.warn).mockClear();
    expect(await h.tick(30)).toMatchObject({ expired: 1 });
    expect(h.store.outbox.rows()).toEqual([]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ reminder: 'expire', tenantId: TENANT }),
      'M119.cron.approval_lifecycle.no_member_recipient',
    );
  });

  it('round-4 B8: a day-30 closure that reaches someone logs no no_member_recipient warn', async () => {
    const h = harness({ broadcasts: [awaitingRow({ memberReminderStage: 3 })] });
    const { logger } = await import('@/lib/logger');
    vi.mocked(logger.warn).mockClear();
    expect(await h.tick(30)).toMatchObject({ expired: 1 });
    expect(vi.mocked(logger.warn).mock.calls.map((c) => c[1])).not.toContain('M119.cron.approval_lifecycle.no_member_recipient');
  });

  // T166 follow-up (the R-L3 class) — the roster is a pool-global read (`users`
  // has no tenant). Read inside each row tx it held a second connection while
  // the row lock was held, once per staff notice. It is now read ONCE per tick,
  // before any row tx; the empty-roster count stays "one per committed hand-off
  // that reached nobody" (the counting `listRecipients` is no longer called).
  describe('T166 follow-up — the marketing roster is read once per tick, outside every row lock', () => {
    const SECOND = '11111111-1111-4111-8111-111111111112' as Broadcast['broadcastId'];
    const V2 = 'aaaaaaaa-0000-4000-8000-000000000002';
    const twoWarnings = () =>
      harness({
        broadcasts: [awaitingRow({ memberReminderStage: 2 }), awaitingRow({ broadcastId: SECOND, memberReminderStage: 2 })],
        versions: [sentV1(), makeApprovalVersion({ id: V2, broadcastId: SECOND, versionNo: 1, sentToMemberAt: T0 })],
      });

    it('two staff notices in one tick → one readRoster, before the first row tx; listRecipients never', async () => {
      const h = twoWarnings();
      const order: string[] = [];
      vi.mocked(h.deps.marketingDirectory.readRoster).mockImplementation(async () => {
        order.push('roster');
        return [MARKETER];
      });
      const lockForUpdate = h.store.broadcastsRepo.lockForUpdate;
      const spy = vi.spyOn(h.store.broadcastsRepo, 'lockForUpdate').mockImplementation(async (...args) => {
        order.push('lock');
        return lockForUpdate(...args);
      });
      expect(await h.tick(23)).toMatchObject({ warningsSent: 2, rowsFailed: 0 });
      expect(h.deps.marketingDirectory.readRoster).toHaveBeenCalledTimes(1);
      expect(h.deps.marketingDirectory.listRecipients).not.toHaveBeenCalled();
      expect(order).toEqual(['roster', 'lock', 'lock']);
      expect(h.store.outbox.rows().filter((r) => r.contextData.audience === 'staff')).toHaveLength(2);
      spy.mockRestore();
    });

    it('an empty roster is counted once per committed staff hand-off — never for a reminder-only tick', async () => {
      const h = twoWarnings();
      vi.mocked(h.deps.marketingDirectory.readRoster).mockResolvedValue([]);
      await h.tick(23);
      expect(h.deps.marketingDirectory.reportEmptyRoster).toHaveBeenCalledTimes(2);

      const reminderOnly = harness({ broadcasts: [awaitingRow()] });
      vi.mocked(reminderOnly.deps.marketingDirectory.readRoster).mockResolvedValue([]);
      expect(await reminderOnly.tick(3)).toMatchObject({ remindersSent: 1 });
      expect(reminderOnly.deps.marketingDirectory.reportEmptyRoster).not.toHaveBeenCalled();
    });

    it('a tick with nothing due reads no roster at all', async () => {
      const h = harness({ broadcasts: [] });
      await h.tick(3);
      expect(h.deps.marketingDirectory.readRoster).not.toHaveBeenCalled();
    });

    it('a roster read that fails fails only the rows that need it: the member reminder still goes', async () => {
      const h = harness({
        broadcasts: [awaitingRow(), awaitingRow({ broadcastId: SECOND, memberReminderStage: 2 })],
        versions: [sentV1(), makeApprovalVersion({ id: V2, broadcastId: SECOND, versionNo: 1, sentToMemberAt: at(-20) })],
      });
      vi.mocked(h.deps.marketingDirectory.readRoster).mockRejectedValue(new TypeError('pool exhausted'));
      // Row 1 is at day 3 (a member reminder); row 2 entered 20 days earlier, so day 23 (needs staff).
      const secondRow = h.store.state.broadcasts.get(`${TENANT}::${SECOND}`)!;
      h.store.state.broadcasts.set(`${TENANT}::${SECOND}`, { ...secondRow, stageEnteredAt: at(-20) });
      const { logger } = await import('@/lib/logger');
      vi.mocked(logger.warn).mockClear();
      expect(await h.tick(3)).toMatchObject({ remindersSent: 1, warningsSent: 0, rowsFailed: 1 });
      expect(h.store.outbox.rows().map((r) => r.contextData.kind)).toEqual(['reminder_day3']);
      // F119 round-4 B3 — the failed row's log names the roster and its cause,
      // not the bare `Error` the staff step used to throw.
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ broadcastId: SECOND, err: 'ApprovalDependencyError:marketing_roster:TypeError' }),
        'M119.cron.approval_lifecycle.row_failed',
      );
    });
  });

  it('the scan and every row transaction set their own statement timeout', async () => {
    const h = harness({ broadcasts: [awaitingRow()] });
    await h.tick(3);
    expect(h.deps.lifecycleScan.setStatementTimeoutInTx).toHaveBeenCalledTimes(2); // the scan tx + the one row tx
  });
});

describe('T125 — nothing is ever auto-approved; expiry exists on exactly one from-state', () => {
  it('a row waiting 400 days produces exactly one expiry and zero approvals — and a second tick changes nothing', async () => {
    const h = harness({ broadcasts: [awaitingRow({ stageEnteredAt: at(-400) })] });
    const expired = vi.spyOn(broadcastsMetrics, 'approvalExpired');
    const first = await h.tick(0);
    const second = await h.tick(0, 60_000);
    expect(first).toMatchObject({ expired: 1, remindersSent: 0, warningsSent: 0, rowsFailed: 0 });
    expect(second).toMatchObject({ expired: 0, remindersSent: 0, warningsSent: 0 });
    expect(eventsOf(h.audit).map((e) => e.eventType)).toEqual(['broadcast_approval_expired']);
    expect((eventsOf(h.audit)[0]!.payload as { days_waiting: number }).days_waiting).toBe(400);
    expect(h.audit.events.map((e) => e.eventType)).not.toContain('broadcast_member_approved');
    const targets = h.store.broadcastsRepo.applyTransition.mock.calls.map((c) => c[3]);
    expect(targets).toEqual(['expired_no_member_response']);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledWith(TENANT);
  });

  it('rows parked at member_approved or approved for 400 days are untouched — even when a scan wrongly lists them, the status re-read under the lock refuses', async () => {
    const parked = [
      awaitingRow({ status: 'member_approved', stageEnteredAt: at(-400), approvedVersionId: V1 }),
      awaitingRow({ broadcastId: '11111111-1111-4111-8111-111111111112' as Broadcast['broadcastId'], status: 'approved', stageEnteredAt: at(-400), approvedVersionId: V1 }),
    ];
    const h = harness({ broadcasts: parked });
    // The real predicate never lists them…
    const result = await h.tick(0);
    expect(result.scanned).toBe(0);
    // …and a scan that did would still change nothing.
    h.deps.lifecycleScan.listAwaitingMemberApprovalInTx.mockResolvedValue(parked.map((b) => ({ broadcastId: b.broadcastId, stageEnteredAt: b.stageEnteredAt })));
    await h.tick(1);
    expect(h.store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    expect(h.store.outbox.rows()).toEqual([]);
    expect(h.audit.events).toEqual([]);
    expect([...h.store.state.broadcasts.values()].map((b) => b.status)).toEqual(['member_approved', 'approved']);
  });
});

describe('T130 — bounds, failure isolation', () => {
  const many = (n: number, day: number) =>
    Array.from({ length: n }, (_, i) =>
      awaitingRow({
        broadcastId: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}` as Broadcast['broadcastId'],
        stageEnteredAt: new Date(at(day).getTime() + i * 1000),
      }),
    );

  it(`at most ${APPROVAL_LIFECYCLE_BATCH} rows per kind per tick, oldest first; the rest wait for the next tick`, async () => {
    const rows = many(APPROVAL_LIFECYCLE_BATCH + 1, -31);
    const h = harness({ broadcasts: rows, versions: rows.map((b) => makeApprovalVersion({ id: V1, broadcastId: b.broadcastId, versionNo: 1, sentToMemberAt: b.stageEnteredAt })) });
    expect((await h.tick(0)).expired).toBe(APPROVAL_LIFECYCLE_BATCH);
    const left = [...h.store.state.broadcasts.values()].filter((b) => b.status === 'awaiting_member_approval');
    expect(left.map((b) => b.broadcastId)).toEqual([rows.at(-1)!.broadcastId]); // the youngest waited
    expect((await h.tick(1)).expired).toBe(1);
  });

  it(`T166 R-L1: ${APPROVAL_LIFECYCLE_BATCH} already-warned rows (stage 3) cannot starve a day-7 reminder — the reminder window skips what it has nothing left to send`, async () => {
    const warned = many(APPROVAL_LIFECYCLE_BATCH + 5, -25).map((b) => ({ ...b, memberReminderStage: 3 as const }));
    const due = awaitingRow({ broadcastId: '11111111-1111-4111-8111-999999999999' as Broadcast['broadcastId'], stageEnteredAt: at(-8), memberReminderStage: 1 });
    const rows = [...warned, due];
    const h = harness({ broadcasts: rows, versions: rows.map((b) => makeApprovalVersion({ id: V1, broadcastId: b.broadcastId, versionNo: 1, sentToMemberAt: b.stageEnteredAt })) });
    expect(await h.tick(0)).toMatchObject({ scanned: 1, remindersSent: 1 });
    expect(h.store.outbox.rows().map((r) => r.contextData.kind)).toEqual(['reminder_day7']);
    // The expiry list is NOT bounded by the stage: a warned row still closes on day 30.
    const expiries = h.deps.lifecycleScan.listAwaitingMemberApprovalInTx.mock.calls.map((c) => c[2]);
    expect(expiries.map((q) => q.reminderStageBelow)).toEqual([3, undefined]);
  });

  it('a row whose transaction throws is rolled back, counted and left for tomorrow; the other rows still go', async () => {
    const rows = many(2, -31);
    const h = harness({ broadcasts: rows, versions: rows.map((b) => makeApprovalVersion({ id: V1, broadcastId: b.broadcastId, versionNo: 1, sentToMemberAt: b.stageEnteredAt })) });
    const original = h.audit.emitTyped;
    (h.deps as { audit: AuditPort }).audit = {
      ...h.audit,
      emitTyped: vi.fn().mockRejectedValueOnce(new Error('audit insert failed')).mockImplementation(original) as AuditPort['emitTyped'],
    };
    // F119 round-4 B8 — a failed row is metered, as the image sweep's are: the
    // tick still returns 200, so a persistent fault was a `warn` line only.
    const rowFailed = vi.spyOn(broadcastsMetrics, 'approvalLifecycleRowFailed');
    const result = await h.tick(0);
    expect(result).toMatchObject({ scanned: 2, expired: 1, rowsFailed: 1 });
    expect(rowFailed).toHaveBeenCalledTimes(1);
    expect(rowFailed).toHaveBeenCalledWith(TENANT);
    const statuses = [...h.store.state.broadcasts.values()].map((b) => b.status);
    expect(statuses.sort()).toEqual(['awaiting_member_approval', 'expired_no_member_response']);
    expect(h.store.outbox.rows().every((r) => r.contextData.broadcastId === rows[1]!.broadcastId)).toBe(true);
  });

  it('a scan that fails is an error result, not a throw', async () => {
    const h = harness({ broadcasts: [awaitingRow()] });
    h.deps.lifecycleScan.listAwaitingMemberApprovalInTx.mockRejectedValue(new Error('statement timeout'));
    h.store.now = at(3);
    const r = await expireStaleMemberApprovals(h.deps, { requestId: 'tick' });
    expect(r.ok ? 'ok' : r.error.kind).toBe('lifecycle.server_error');
  });
});

// ---------------------------------------------------------------------------
// The route wire — the block rides `prune-expired-drafts` (no new cron job)
// ---------------------------------------------------------------------------

const route = vi.hoisted(() => ({ prune: vi.fn(), reclaim: vi.fn(), lifecycle: vi.fn(), f7: true }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }) }));
vi.mock('@/lib/env', () => ({
  env: {
    cron: { secret: 'cron-secret-for-test' },
    get features() {
      return { f7Broadcasts: route.f7 };
    },
  },
}));
vi.mock('@/modules/broadcasts', () => ({
  pruneExpiredDrafts: (...a: unknown[]) => route.prune(...a),
  makePruneExpiredDraftsDeps: () => ({}),
  reclaimOrphanedImages: (...a: unknown[]) => route.reclaim(...a),
  makeReclaimOrphanedImagesDeps: () => ({}),
  expireStaleMemberApprovals: (...a: unknown[]) => route.lifecycle(...a),
}));
vi.mock('@/lib/broadcast-approval-deps', () => ({ makeExpireStaleMemberApprovalsDeps: () => ({}) }));

describe('prune-expired-drafts — the approval-lifecycle block (T130)', () => {
  const req = (method: 'GET' | 'POST', auth: string | null = 'Bearer cron-secret-for-test') =>
    new NextRequest('http://localhost/api/cron/broadcasts/prune-expired-drafts', { method, headers: auth ? { authorization: auth } : {} });
  const importRoute = () => import('@/app/api/cron/broadcasts/prune-expired-drafts/route');
  const lifecycleOk = { scanned: 3, remindersSent: 1, warningsSent: 1, expired: 1, rowsFailed: 0 };

  beforeEach(() => {
    vi.resetModules();
    route.f7 = true;
    route.prune.mockReset().mockResolvedValue(ok({ prunedCount: 2, cutoff: '2026-08-19T00:00:00.000Z' }));
    route.reclaim.mockReset().mockResolvedValue(ok({ scanned: 0, blobsDeleted: 0, rowsRemoved: 0, retained: 0, rowsFailed: 0 }));
    route.lifecycle.mockReset().mockResolvedValue(ok(lifecycleOk));
  });
  afterEach(() => vi.clearAllMocks());

  it('GET is POST; all three halves run and the body carries remindersSent / warningsSent / expired and approvalLifecycleOk', async () => {
    const { GET, POST } = await importRoute();
    expect(GET).toBe(POST);
    const res = await GET(req('GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pruneOk: true, imageSweep: { ok: true }, approvalLifecycleOk: true, remindersSent: 1, warningsSent: 1, expired: 1 });
    expect(route.lifecycle).toHaveBeenCalledTimes(1);
    expect(route.lifecycle.mock.calls[0]![1]).toMatchObject({ requestId: expect.stringMatching(/^cron-approval-lifecycle-/) });
  });

  it('the CRON_SECRET bearer guards the new block too: no header, a wrong one → 401 and nothing runs', async () => {
    const { POST } = await importRoute();
    for (const auth of [null, 'Bearer wrong']) {
      expect((await POST(req('POST', auth))).status).toBe(401);
    }
    expect(route.lifecycle).not.toHaveBeenCalled();
  });

  it('a lifecycle fault never drops the other halves — both reported, 500 only at the end', async () => {
    route.lifecycle.mockRejectedValueOnce(new Error('neon down'));
    const { POST } = await importRoute();
    const res = await POST(req('POST'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ pruneOk: true, prunedCount: 2, imageSweep: { ok: true }, approvalLifecycleOk: false });
    expect(route.prune).toHaveBeenCalledTimes(1);
    expect(route.reclaim).toHaveBeenCalledTimes(1);
  });

  it('an error result is a fault as well; and a prune fault never drops the lifecycle', async () => {
    route.lifecycle.mockResolvedValueOnce(err({ kind: 'lifecycle.server_error', errKind: 'Error' }));
    const { POST } = await importRoute();
    const first = await POST(req('POST'));
    expect(first.status).toBe(500);
    expect((await first.json()).approvalLifecycleOk).toBe(false);

    route.prune.mockRejectedValueOnce(new Error('prune failed'));
    const second = await POST(req('POST'));
    expect(second.status).toBe(500);
    expect(await second.json()).toMatchObject({ pruneOk: false, approvalLifecycleOk: true, expired: 1 });
  });

  it('F7 kill switch off → skipped, the lifecycle does not run', async () => {
    route.f7 = false;
    const { POST } = await importRoute();
    const res = await POST(req('POST'));
    expect(await res.json()).toEqual({ skipped: true, reason: 'feature_disabled' });
    expect(route.lifecycle).not.toHaveBeenCalled();
  });
});
