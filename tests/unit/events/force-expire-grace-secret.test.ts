/**
 * Unit tests for the `forceExpireGraceSecret` use-case.
 *
 * Covers:
 *   - happy `no_grace_active` (rowsCleared = 0) + audit emitted
 *   - happy `cleared` (rowsCleared = 1) + audit emitted with actor + reason
 *   - repo `db_error` short-circuits BEFORE the audit emit
 *   - audit emit failure surfaces `audit_emit_failed`
 *   - `input.now` forwarded verbatim to both repo and audit
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { logger } from '@/lib/logger';
import { forceExpireGraceSecret } from '@/modules/events';
import type {
  TenantWebhookConfigRepository,
} from '@/modules/events/application/ports/tenant-webhook-config-repository';
import type { F6AuditPort } from '@/modules/events/application/ports/audit-port';
import type { TenantId } from '@/modules/members';
import type { UserId, AuditEventId } from '@/modules/auth';

function makeRepo(
  overrides: Partial<TenantWebhookConfigRepository> = {},
): TenantWebhookConfigRepository {
  return {
    insert: vi.fn(),
    findByTenantSource: vi.fn(),
    rotateSecret: vi.fn(),
    setEnabled: vi.fn(),
    touchLastReceivedAt: vi.fn(),
    clearExpiredGrace: vi.fn(),
    ...overrides,
  };
}

function makeAudit(
  overrides: Partial<F6AuditPort> = {},
): F6AuditPort {
  return {
    emit: vi.fn().mockResolvedValue(ok('audit-id' as AuditEventId)),
    emitRolledBack: vi.fn(),
    emitStandalone: vi.fn(),
    ...overrides,
  };
}

const TENANT: TenantId = 'test-swecham' as TenantId;
const ACTOR: UserId = 'usr_admin_001' as UserId;

describe('forceExpireGraceSecret', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  });

  it('cleared — rowsCleared=1 and audit emitted with admin actor + reason + occurredAt forwarded', async () => {
    const clearExpiredGrace = vi.fn().mockResolvedValue(ok(1));
    const auditEmit = vi.fn().mockResolvedValue(ok('audit-id' as AuditEventId));
    const repo = makeRepo({ clearExpiredGrace });
    const audit = makeAudit({ emit: auditEmit });

    const now = new Date('2026-05-12T10:00:00.000Z');
    const result = await forceExpireGraceSecret(
      {
        tenantId: TENANT,
        actorUserId: ACTOR,
        reason: 'incident INC-42 — OLD secret suspected leaked',
        now,
      },
      { repo, audit },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ kind: 'cleared', rowsCleared: 1 });

    expect(clearExpiredGrace).toHaveBeenCalledWith(TENANT, now);
    expect(auditEmit).toHaveBeenCalledTimes(1);
    const entry = auditEmit.mock.calls[0]![0];
    expect(entry.eventType).toBe('webhook_secret_force_expired');
    expect(entry.actorType).toBe('admin');
    expect(entry.actorUserId).toBe(ACTOR);
    expect(entry.occurredAt).toBe(now); // input.now forwarded to audit
    expect(entry.payload).toMatchObject({
      severity: 'warn',
      actorUserId: ACTOR,
      rowsCleared: 1,
      reason: 'incident INC-42 — OLD secret suspected leaked',
    });
  });

  it('audit_emit_failed → logger.fatal preserves forensic trail', async () => {
    const repo = makeRepo({
      clearExpiredGrace: vi.fn().mockResolvedValue(ok(1)),
    });
    const audit = makeAudit({
      emit: vi
        .fn()
        .mockResolvedValue(err({ kind: 'db_error', message: 'audit insert failed' })),
    });

    const result = await forceExpireGraceSecret(
      { tenantId: TENANT, actorUserId: ACTOR, reason: 'incident', now: new Date() },
      { repo, audit },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('audit_emit_failed');
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_force_expire_audit_emit_failed' }),
      expect.stringContaining('audit emit failed'),
    );
  });

  it('rowsCleared > 1 → invariant violation throws + logger.fatal', async () => {
    const repo = makeRepo({
      clearExpiredGrace: vi.fn().mockResolvedValue(ok(2)),
    });

    await expect(
      forceExpireGraceSecret(
        { tenantId: TENANT, actorUserId: ACTOR, reason: 'x', now: new Date() },
        { repo, audit: makeAudit() },
      ),
    ).rejects.toThrow(/invariant violated.*rowsCleared=2/);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_force_expire_unexpected_row_count' }),
      expect.any(String),
    );
  });

  it('no_grace_active — rowsCleared=0 still emits audit (forensic completeness)', async () => {
    const auditEmit = vi.fn().mockResolvedValue(ok('audit-id' as AuditEventId));
    const repo = makeRepo({
      clearExpiredGrace: vi.fn().mockResolvedValue(ok(0)),
    });

    const result = await forceExpireGraceSecret(
      {
        tenantId: TENANT,
        actorUserId: null, // ops script invocation
        reason: 'runbook step 4.1',
        now: new Date(),
      },
      { repo, audit: makeAudit({ emit: auditEmit }) },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ kind: 'no_grace_active' });

    expect(auditEmit).toHaveBeenCalledTimes(1);
    const entry = auditEmit.mock.calls[0]![0];
    expect(entry.actorType).toBe('system');
    expect(entry.actorUserId).toBe(null);
    expect(entry.payload).toMatchObject({ rowsCleared: 0 });
  });

  it('db_error from repo short-circuits BEFORE audit emit', async () => {
    const auditEmit = vi.fn();
    const repo = makeRepo({
      clearExpiredGrace: vi.fn().mockResolvedValue(
        err({ kind: 'db_error', message: 'connection refused' }),
      ),
    });

    const result = await forceExpireGraceSecret(
      { tenantId: TENANT, actorUserId: ACTOR, reason: 'x', now: new Date() },
      { repo, audit: makeAudit({ emit: auditEmit }) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it('audit emit failure surfaces `audit_emit_failed`', async () => {
    const repo = makeRepo({
      clearExpiredGrace: vi.fn().mockResolvedValue(ok(1)),
    });
    const audit = makeAudit({
      emit: vi
        .fn()
        .mockResolvedValue(err({ kind: 'db_error', message: 'audit insert failed' })),
    });

    const result = await forceExpireGraceSecret(
      { tenantId: TENANT, actorUserId: ACTOR, reason: 'x', now: new Date() },
      { repo, audit },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('audit_emit_failed');
    if (result.error.kind === 'audit_emit_failed') {
      expect(result.error.inner.kind).toBe('db_error');
    }
  });

  it('passes through a not_found error from the repo', async () => {
    const repo = makeRepo({
      clearExpiredGrace: vi.fn().mockResolvedValue(
        err({ kind: 'not_found', tenantId: TENANT, source: 'eventcreate' }),
      ),
    });

    const result = await forceExpireGraceSecret(
      { tenantId: TENANT, actorUserId: ACTOR, reason: 'x', now: new Date() },
      { repo, audit: makeAudit() },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('not_found');
  });
});
