/**
 * Round-3 review gap (MED-2, criticality 7): the `handleInvitationBounce`
 * orchestrator's fail-soft NEVER-THROW contract was untested. Its whole reason
 * to exist is: "a per-tenant failure is logged but never thrown, so the webhook
 * always returns 200 — a 5xx would trigger a Resend retry storm." A regression
 * here is a production incident. This suite pins the three degraded branches.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// resolveBouncedInviteContacts (same module) reads via the global `db` client.
vi.mock('@/lib/db', () => ({
  db: { select: vi.fn() },
  runInTenant: vi.fn(),
}));

// Mock the use-case so we control each per-target outcome.
vi.mock(
  '@/modules/members/application/use-cases/mark-invitation-bounced',
  () => ({ markInvitationBounced: vi.fn() }),
);

// Adapter modules are imported by the orchestrator but unused once
// markInvitationBounced is mocked; stub to avoid pulling real infra.
vi.mock('@/modules/members/infrastructure/db/drizzle-contact-repo', () => ({
  drizzleContactRepo: {},
}));
vi.mock('@/modules/members/infrastructure/audit/audit-adapter', () => ({
  drizzleAuditAdapter: {},
}));

import { db } from '@/lib/db';
import { handleInvitationBounce } from '@/modules/members/infrastructure/handle-invitation-bounce';
import { markInvitationBounced } from '@/modules/members/application/use-cases/mark-invitation-bounced';

const selectMock = db.select as unknown as Mock;
const markMock = markInvitationBounced as unknown as Mock;

/** Stub the resolver's `db.select().from().innerJoin().where().limit()` chain. */
function mockResolve(
  rows: Array<{ tenantId: string; memberId: string; contactId: string; email: string }>,
): void {
  selectMock.mockReturnValue({
    from: () => ({
      innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  });
}

function target(n: number) {
  return {
    tenantId: `tenant-${n}`,
    memberId: `00000000-0000-4000-8000-00000000000${n}`,
    contactId: `00000000-0000-4000-8000-00000000010${n}`,
    email: 'bounce@example.com',
  };
}

describe('handleInvitationBounce — fail-soft never-throw contract (MED-2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolver throws → returns { marked: 0 }, does NOT throw', async () => {
    selectMock.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(
      handleInvitationBounce('bounce@example.com', 'req-1'),
    ).resolves.toEqual({ marked: 0 });
  });

  it('one target throws, another succeeds → other still marked, no throw', async () => {
    mockResolve([target(1), target(2)]);
    markMock
      .mockRejectedValueOnce(new Error('target-1 blew up'))
      .mockResolvedValueOnce(ok({ marked: true }));
    await expect(
      handleInvitationBounce('bounce@example.com', 'req-2'),
    ).resolves.toEqual({ marked: 1 });
    expect(markMock).toHaveBeenCalledTimes(2); // batch NOT aborted by target-1
  });

  it('target returns err → returns { marked: 0 }, no throw', async () => {
    mockResolve([target(1)]);
    markMock.mockResolvedValue(err({ type: 'server_error', message: 'repo.unexpected' }));
    await expect(
      handleInvitationBounce('bounce@example.com', 'req-3'),
    ).resolves.toEqual({ marked: 0 });
  });

  it('idempotent target (marked:false) → counted as 0, no throw', async () => {
    mockResolve([target(1)]);
    markMock.mockResolvedValue(ok({ marked: false }));
    await expect(
      handleInvitationBounce('bounce@example.com', 'req-4'),
    ).resolves.toEqual({ marked: 0 });
  });
});
