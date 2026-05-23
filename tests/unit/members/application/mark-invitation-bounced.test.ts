/**
 * Unit coverage for the `markInvitationBounced` use-case error/idempotent
 * paths (round-2 review gap). The happy / cross-tenant / live-DB paths are
 * covered by tests/integration/members/invitation-bounced-edge-case.test.ts;
 * this suite locks the throw-to-rollback + idempotent-no-op contract with
 * stubbed deps (the spec calls a silent bounce "a data integrity bug").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// runInTenant stub — invokes the callback with a dummy tx and re-throws
// anything thrown inside (so UseCaseAbort surfaces to the use-case catch).
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { markInvitationBounced } from '@/modules/members/application/use-cases/mark-invitation-bounced';
import type { MarkInvitationBouncedDeps } from '@/modules/members/application/use-cases/mark-invitation-bounced';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';
import { asContactId } from '@/modules/members/domain/contact';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const contactId = asContactId('22222222-2222-4222-8222-222222222222');

function makeDeps(options: {
  markResult: ReturnType<typeof ok> | ReturnType<typeof err>;
  auditResult: ReturnType<typeof ok> | ReturnType<typeof err>;
}): MarkInvitationBouncedDeps {
  return {
    tenant,
    contactRepo: {
      markInviteBouncedInTx: vi.fn().mockResolvedValue(options.markResult),
    } as unknown as MarkInvitationBouncedDeps['contactRepo'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn().mockResolvedValue(options.auditResult),
    },
  };
}

const input = {
  contactId,
  memberId,
  toEmail: 'bounce@example.com',
  requestId: 'req-mark-bounce',
  bouncedAt: new Date('2026-05-22T00:00:00Z'),
};

describe('markInvitationBounced — error + idempotent paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks + audits when the contact had a live pending invite (affected=1)', async () => {
    const deps = makeDeps({
      markResult: ok({ affected: 1 }),
      auditResult: ok(undefined),
    });
    const result = await markInvitationBounced(deps, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.marked).toBe(true);
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
  });

  it('idempotent no-op (affected=0) → ok(marked:false), NO audit row', async () => {
    const deps = makeDeps({
      markResult: ok({ affected: 0 }),
      auditResult: ok(undefined),
    });
    const result = await markInvitationBounced(deps, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.marked).toBe(false);
    // No state change → no audit row (re-delivered / already-marked bounce).
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('returns server_error + rolls back when the mark write fails (audit NOT attempted)', async () => {
    const deps = makeDeps({
      markResult: err({ code: 'repo.unexpected' as const, cause: 'db down' }),
      auditResult: ok(undefined),
    });
    const result = await markInvitationBounced(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
    // Throw short-circuits before the audit emit.
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('returns server_error + rolls back when the audit emit fails after a successful mark', async () => {
    const deps = makeDeps({
      markResult: ok({ affected: 1 }),
      auditResult: err({ code: 'repo.unexpected' as const }),
    });
    const result = await markInvitationBounced(deps, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
    // Audit was attempted (we exercised the failure branch) and the use-case
    // still surfaced err — proving the UseCaseAbort throw-to-rollback path.
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
  });
});
