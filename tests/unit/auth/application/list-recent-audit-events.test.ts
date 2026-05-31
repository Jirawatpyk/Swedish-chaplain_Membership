/**
 * `listRecentAuditEvents` unit test — ok path + the `read_failed` branch.
 *
 * The reader hits live Postgres (raw Drizzle) and can throw; the use-case must
 * surface that as an explicit `read_failed` Result so callers (the F9 activity
 * feed) degrade deliberately instead of letting an unhandled rejection 500 the
 * dashboard.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  listRecentAuditEvents,
  type AuditReadPort,
  type RecentAuditEvent,
} from '@/modules/auth/application/use-cases/list-recent-audit-events';

const ctx = asTenantContext('test-tenant');

const ROW: RecentAuditEvent = {
  id: 'evt-1',
  eventType: 'sign_in_success',
  actorUserId: 'actor-1',
  targetUserId: null,
  summary: 'signed in',
  occurredAt: new Date('2026-06-15T05:00:00.000Z'),
  requestId: 'req-1',
};

describe('listRecentAuditEvents', () => {
  it('returns ok with the reader rows', async () => {
    const auditRead: AuditReadPort = { listRecent: vi.fn().mockResolvedValue([ROW]) };
    const result = await listRecentAuditEvents({ limit: 10 }, ctx, { auditRead });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([ROW]);
    expect(auditRead.listRecent).toHaveBeenCalledWith(ctx, 10);
  });

  it('clamps the limit to [1, 100]', async () => {
    const auditRead: AuditReadPort = { listRecent: vi.fn().mockResolvedValue([]) };
    await listRecentAuditEvents({ limit: 9999 }, ctx, { auditRead });
    expect(auditRead.listRecent).toHaveBeenCalledWith(ctx, 100);
  });

  it('surfaces read_failed when the reader throws (no unhandled rejection)', async () => {
    const auditRead: AuditReadPort = {
      listRecent: vi.fn().mockRejectedValue(new Error('neon down')),
    };
    const result = await listRecentAuditEvents({ limit: 10 }, ctx, { auditRead });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('read_failed');
  });
});
