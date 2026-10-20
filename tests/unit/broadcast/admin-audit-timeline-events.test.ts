/**
 * Spec 122 US12c-1 follow-up (maintainer, 20 Oct) — the Lifecycle timeline
 * shows the approval round's own steps. On a round the row never emits
 * `broadcast_approved` (that is approve-as-submitted only): the member's
 * approval (`broadcast_member_approved`, record-member-decision), their
 * request for changes (`broadcast_member_changes_requested`) and marketing's
 * send-time confirmation (`broadcast_schedule_confirmed`, confirm-schedule)
 * are the steps. Those rows key the E-Blast as `broadcast_id`, the F7 rows
 * as `broadcastId`.
 */
import { describe, expect, it, vi } from 'vitest';

const executed: string[] = [];
vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: { execute: (q: unknown) => Promise<unknown[]> }) => Promise<unknown>) =>
    fn({
      execute: async (q: unknown) => {
        executed.push(JSON.stringify(q));
        return [];
      },
    }),
}));
vi.mock('@/lib/env', () => ({ env: { tenant: { timezone: 'Asia/Bangkok' } } }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

import { AuditTimeline, timelineLabelKey } from '@/components/broadcast/admin/audit-timeline';

describe('timelineLabelKey', () => {
  it('labels the approval-round steps', () => {
    expect(timelineLabelKey('broadcast_member_approved', null)).toBe('memberApproved');
    expect(timelineLabelKey('broadcast_member_changes_requested', null)).toBe('memberChangesRequested');
    expect(timelineLabelKey('broadcast_schedule_confirmed', 'keep_proposal')).toBe('scheduleConfirmed');
    expect(timelineLabelKey('broadcast_schedule_confirmed', 'send_now')).toBe('scheduleConfirmed');
    expect(timelineLabelKey('broadcast_schedule_confirmed', 'cancel')).toBe('scheduleCancelled');
  });

  it('keeps the lifecycle steps it had', () => {
    expect(timelineLabelKey('broadcast_approved', null)).toBe('approved');
    expect(timelineLabelKey('broadcast_failed_to_dispatch', null)).toBe('failedToDispatch');
  });
});

describe('AuditTimeline query', () => {
  it('reads the round steps, which key the E-Blast as broadcast_id, beside the F7 rows (broadcastId)', async () => {
    executed.length = 0;
    await AuditTimeline({ tenantId: 'tenant-a', broadcastId: 'b-1' });
    const q = executed.join('\n');
    expect(q).toContain("payload->>'broadcastId'");
    expect(q).toContain("payload->>'broadcast_id'");
    for (const e of ['broadcast_member_approved', 'broadcast_member_changes_requested', 'broadcast_schedule_confirmed']) {
      expect(q, e).toContain(e);
    }
    expect(q).toContain("payload->>'mode'");
  });
});
