/**
 * Member timeline — staff-internal audit rows are hidden from member viewers.
 *
 * `member_timeline_v` carries every audit row with a `member_id` /
 * `related_member_id` key, internal ones included (churn-risk scoring,
 * escalation tasks, reminder plumbing, the security fail-open notice). For a
 * member-role viewer the use case must (a) push the allowlist down to the repo
 * so `total` and the cursor are computed over the visible set, and (b) drop any
 * non-allowlisted audit row the repo still returned. Staff see everything.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';
import { timelineList } from '@/modules/members/application/use-cases/timeline-list';
import {
  MEMBER_VISIBLE_AUDIT_EVENT_TYPES,
  isMemberVisibleAuditType,
} from '@/modules/members/application/member-visible-audit-types';
import { ALL_AUDIT_EVENT_TYPES } from '@/modules/auth';
import type { TenantContext } from '@/modules/tenants';
import type { MemberRepo } from '@/modules/members/application/ports/member-repo';
import type {
  TimelinePort,
  TimelineFilter,
} from '@/modules/members/application/ports/timeline-port';

const CTX = { slug: 'test-tenant' } as unknown as TenantContext;
const MEMBER = '00000000-0000-4000-8000-000000000001';
const AS_MEMBER = { actorUserId: 'u-m', actorRole: 'member' as const, requestId: 'r1' };
const AS_ADMIN = { actorUserId: 'u-a', actorRole: 'admin' as const, requestId: 'r2' };
const AS_MARKETING = { actorUserId: 'u-k', actorRole: 'marketing' as const, requestId: 'r3' };

/**
 * Every audit type that reaches `member_timeline_v` but must stay off a
 * member's timeline. Pinned exactly: moving one of these onto the allowlist is
 * a product decision, and should fail here first.
 */
const HIDDEN = [
  'at_risk_score_recomputed',
  'at_risk_score_threshold_crossed',
  'at_risk_snoozed',
  'at_risk_outreach_recorded',
  'at_risk_skipped_below_min_tenure',
  'escalation_task_created',
  'escalation_task_completed',
  'escalation_task_skipped',
  'escalation_task_reassigned',
  'renewal_reminder_skipped',
  'renewal_reminder_send_failed',
  'renewal_reminder_send_failed_permanent',
  'renewal_reminder_retried',
  'renewal_reminder_deferred_read_only',
  'renewal_schedule_rescheduled',
  'renewal_schedule_reschedule_skipped',
  'renewal_lapse_deferred_invoice_not_due',
  'renewal_lapse_deferred_warning_pending',
  'renewal_auto_drafted',
  'renewal_auto_draft_discarded',
  'renewal_orphan_invoice_relinked',
  'tier_upgrade_suggested',
  'tier_upgrade_dismissed',
  'tier_upgrade_already_at_target',
  'tier_upgrade_pending_admin_verification_due',
  'tier_upgrade_pending_orphan_detected',
  'tier_upgrade_pending_member_notify_skipped',
  'tier_upgrade_pending_member_notify_failed',
  'tier_upgrade_apply_post_invoice_paid_failed',
  'membership_access_fail_open',
  'member_auto_reactivation_blocked',
  'member_auto_reactivation_unblocked',
  'lapsed_member_admin_reactivation_reminder_t-1',
  'lapsed_member_admin_reactivation_reminder_t-3',
  'lapsed_member_admin_reactivation_reminder_t-7',
  'invoice_draft_created',
  'invoice_pdf_downloaded',
  'receipt_pdf_downloaded',
  'receipt_rendered',
  'event_buyer_pii_redacted',
  'broadcast_content_redacted',
  'broadcast_image_removed',
  'subprocessor_erasure_propagated',
  'member_self_update_forbidden',
  'member_plan_change_billing_effect',
] as const;

function auditRow(id: string, eventType: string, day: number) {
  return {
    id,
    source: 'audit' as const,
    timestamp: new Date(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`),
    actorUserId: 'u-staff',
    actorDisplayName: 'Staff',
    actorKind: 'staff' as const,
    eventType,
    payload: { member_id: MEMBER },
  };
}

const EVENT_ROW = {
  id: 'e-attended',
  source: 'event' as const,
  timestamp: new Date('2026-08-01T00:00:00.000Z'),
  actorDisplayName: null,
  actorKind: 'member' as const,
  eventType: 'attended',
  payload: { event_id: 'ev-1' },
};

const PAGE = [
  auditRow('e-risk', 'at_risk_score_recomputed', 6),
  auditRow('e-task', 'escalation_task_created', 5),
  auditRow('e-failopen', 'membership_access_fail_open', 4),
  auditRow('e-upd', 'member_updated', 3),
  auditRow('e-unknown', 'some_future_internal_event', 2),
  EVENT_ROW,
];

function makeDeps(events: readonly unknown[], total = events.length) {
  const captured: { filter?: TimelineFilter } = {};
  const memberRepo = {
    findById: vi.fn().mockResolvedValue(ok({})),
  } as unknown as MemberRepo;
  const timeline = {
    listByMember: vi.fn(async (_ctx: TenantContext, filter: TimelineFilter) => {
      captured.filter = filter;
      return ok({ events, nextCursor: null, total });
    }),
  } as unknown as TimelinePort;
  return {
    deps: { memberRepo, timeline, invoicingRead: true, viewerContactId: null },
    captured,
  };
}

describe('timelineList — member viewers see only member-facing audit types', () => {
  it('pushes the allowlist down to the repo for a member viewer (total + cursor)', async () => {
    const { deps, captured } = makeDeps([]);
    const r = await timelineList({ memberId: MEMBER, limit: 50 }, AS_MEMBER, CTX, deps);
    expect(r.ok).toBe(true);
    expect(captured.filter?.auditEventTypeAllowlist).toEqual(MEMBER_VISIBLE_AUDIT_EVENT_TYPES);
  });

  it.each([
    ['admin', AS_ADMIN],
    ['marketing', AS_MARKETING],
  ])('passes no allowlist for a %s viewer', async (_label, meta) => {
    const { deps, captured } = makeDeps([]);
    await timelineList({ memberId: MEMBER, limit: 50 }, meta, CTX, deps);
    expect(captured.filter).toBeDefined();
    expect(captured.filter?.auditEventTypeAllowlist).toBeUndefined();
  });

  it('drops internal and unknown audit rows the repo returned, and the count follows', async () => {
    const { deps } = makeDeps(PAGE, 10);
    const r = await timelineList({ memberId: MEMBER, limit: 50 }, AS_MEMBER, CTX, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events.map((e) => e.id)).toEqual(['e-upd', 'e-attended']);
    // four hidden rows on this page → the header count drops by four
    expect(r.value.total).toBe(6);
  });

  it('leaves a staff viewer\'s stream untouched', async () => {
    const { deps } = makeDeps(PAGE, 10);
    const r = await timelineList({ memberId: MEMBER, limit: 50 }, AS_ADMIN, CTX, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.events.map((e) => e.id)).toEqual(PAGE.map((e) => e.id));
    expect(r.value.total).toBe(10);
  });
});

describe('MEMBER_VISIBLE_AUDIT_EVENT_TYPES', () => {
  it('contains none of the staff-internal types', () => {
    for (const t of HIDDEN) {
      expect(isMemberVisibleAuditType(t), `${t} must stay hidden from members`).toBe(false);
    }
  });

  it('holds no internal-family prefix', () => {
    for (const t of MEMBER_VISIBLE_AUDIT_EVENT_TYPES) {
      expect(t).not.toMatch(/^(at_risk_|escalation_task_|renewal_schedule_|renewal_lapse_deferred_)/);
    }
  });

  it('names only real audit event types (typo guard)', () => {
    const all = new Set<string>(ALL_AUDIT_EVENT_TYPES);
    for (const t of MEMBER_VISIBLE_AUDIT_EVENT_TYPES) {
      expect(all.has(t), `${t} is not an audit event type`).toBe(true);
    }
    for (const t of HIDDEN) {
      expect(all.has(t), `${t} is not an audit event type`).toBe(true);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(MEMBER_VISIBLE_AUDIT_EVENT_TYPES).size).toBe(
      MEMBER_VISIBLE_AUDIT_EVENT_TYPES.length,
    );
  });
});
