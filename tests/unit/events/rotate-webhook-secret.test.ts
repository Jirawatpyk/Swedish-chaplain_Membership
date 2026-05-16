/**
 * Unit tests for `rotateWebhookSecret` use-case (T071).
 *
 * Covers:
 *   - happy → rotates + emits `webhook_secret_rotated` audit with
 *     previousSecretLastFour, newSecretLastFour, graceActiveUntil
 *   - `not_found` from repo → preserved error (caller maps to 404)
 *   - `db_error` from repo → preserved error
 *   - audit failure → `audit_emit_failed` + logger.fatal
 *   - `graceActiveUntil` is exactly `now + 24h`
 *   - audit summary contains only last4 (NEVER plaintext)
 *   - `generateSecret` invoked exactly once
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { logger } from '@/lib/logger';
import { rotateWebhookSecret } from '@/modules/events/application/use-cases/rotate-webhook-secret';
import type {
  TenantWebhookConfigRepository,
} from '@/modules/events/application/ports/tenant-webhook-config-repository';
import type { F6AuditPort } from '@/modules/events/application/ports/audit-port';
import type { TenantId } from '@/modules/members';
import type { UserId, AuditEventId } from '@/modules/auth';
import type { WebhookSecret, TenantWebhookConfigAggregate } from '@/modules/events';

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
    findPriorErasureCompletion: vi.fn().mockResolvedValue(ok(false)),
    ...overrides,
  };
}

const TENANT: TenantId = 'test-swecham' as TenantId;
const ACTOR: UserId = 'usr_admin_001' as UserId;
const OLD_SECRET = 'whsec_OLD_value_with_visible_last_four_OLD4' as WebhookSecret;
const NEW_SECRET = 'whsec_NEW_value_with_visible_last_four_NEW4' as WebhookSecret;

function makeAggregate(active: WebhookSecret, grace: WebhookSecret | null, now: Date): TenantWebhookConfigAggregate {
  return {
    tenantId: TENANT,
    source: 'eventcreate',
    activeSecret: active,
    graceSecret: grace,
    graceRotatedAt: grace ? now : null,
    enabled: true,
    createdAt: new Date('2026-05-13T00:00:00Z'),
    lastReceivedAt: null,
    lastRotatedAt: now,
  };
}

describe('rotateWebhookSecret', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  });

  it('happy — rotates + emits audit + returns new secret + graceActiveUntil = now+24h', async () => {
    const now = new Date('2026-05-13T12:00:00.000Z');
    const rotateSecret = vi
      .fn()
      .mockResolvedValue(ok(makeAggregate(NEW_SECRET, OLD_SECRET, now)));
    const auditEmit = vi.fn().mockResolvedValue(ok('audit-id' as AuditEventId));
    const repo = makeRepo({ rotateSecret });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(NEW_SECRET);

    const result = await rotateWebhookSecret(
      { tenantId: TENANT, source: 'eventcreate', actorUserId: ACTOR, now },
      { repo, audit, generateSecret },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.secret).toBe(NEW_SECRET);
    expect(result.value.secretLastFour).toBe('NEW4');
    // 24h after now = 2026-05-14T12:00:00.000Z
    expect(result.value.graceActiveUntil).toBe('2026-05-14T12:00:00.000Z');

    expect(rotateSecret).toHaveBeenCalledWith({
      tenantId: TENANT,
      source: 'eventcreate',
      newActiveSecret: NEW_SECRET,
      now,
    });
    expect(auditEmit).toHaveBeenCalledTimes(1);
    const entry = auditEmit.mock.calls[0]![0];
    expect(entry.eventType).toBe('webhook_secret_rotated');
    expect(entry.actorType).toBe('admin');
    expect(entry.actorUserId).toBe(ACTOR);
    expect(entry.payload.previousSecretLastFour).toBe('OLD4');
    expect(entry.payload.newSecretLastFour).toBe('NEW4');
    expect(entry.payload.graceActiveUntil).toBe('2026-05-14T12:00:00.000Z');
    expect(entry.payload.severity).toBe('warn');
    // Plaintext secrets MUST NOT appear in the audit summary or payload.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(OLD_SECRET);
    expect(serialised).not.toContain(NEW_SECRET);
  });

  it('not_found from repo → preserved error (no audit emitted)', async () => {
    const rotateSecret = vi.fn().mockResolvedValue(
      err({ kind: 'not_found' as const, tenantId: TENANT, source: 'eventcreate' as const }),
    );
    const auditEmit = vi.fn();
    const repo = makeRepo({ rotateSecret });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(NEW_SECRET);

    const result = await rotateWebhookSecret(
      {
        tenantId: TENANT,
        source: 'eventcreate',
        actorUserId: ACTOR,
        now: new Date(),
      },
      { repo, audit, generateSecret },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('not_found');
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it('db_error from repo → preserved error', async () => {
    const rotateSecret = vi.fn().mockResolvedValue(
      err({ kind: 'db_error' as const, message: 'connection lost' }),
    );
    const repo = makeRepo({ rotateSecret });
    const audit = makeAudit();
    const generateSecret = vi.fn().mockReturnValue(NEW_SECRET);

    const result = await rotateWebhookSecret(
      {
        tenantId: TENANT,
        source: 'eventcreate',
        actorUserId: ACTOR,
        now: new Date(),
      },
      { repo, audit, generateSecret },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
  });

  it('audit failure → audit_emit_failed + logger.fatal fires (no plaintext leakage)', async () => {
    const now = new Date('2026-05-13T12:00:00.000Z');
    const rotateSecret = vi
      .fn()
      .mockResolvedValue(ok(makeAggregate(NEW_SECRET, OLD_SECRET, now)));
    const auditEmit = vi.fn().mockResolvedValue(
      err({ kind: 'db_error' as const, message: 'audit unreachable' }),
    );
    const repo = makeRepo({ rotateSecret });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(NEW_SECRET);
    const fatalSpy = vi.spyOn(logger, 'fatal');

    const result = await rotateWebhookSecret(
      { tenantId: TENANT, source: 'eventcreate', actorUserId: ACTOR, now },
      { repo, audit, generateSecret },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('audit_emit_failed');
    expect(fatalSpy).toHaveBeenCalledTimes(1);
    const fatalArgs = fatalSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(fatalArgs['event']).toBe('f6_rotate_secret_audit_emit_failed');
    // CRITICAL: forensic log MUST NOT carry plaintext.
    expect(JSON.stringify(fatalArgs)).not.toContain(NEW_SECRET);
    expect(JSON.stringify(fatalArgs)).not.toContain(OLD_SECRET);
    // last4 should appear so SRE can correlate post-incident.
    expect(fatalArgs['newSecretLastFour']).toBe('NEW4');
    expect(fatalArgs['previousSecretLastFour']).toBe('OLD4');
  });

  it('generateSecret invoked exactly once and result threaded into repo', async () => {
    const now = new Date('2026-05-13T12:00:00.000Z');
    const rotateSecret = vi
      .fn()
      .mockResolvedValue(ok(makeAggregate(NEW_SECRET, OLD_SECRET, now)));
    const repo = makeRepo({ rotateSecret });
    const audit = makeAudit();
    const generateSecret = vi.fn().mockReturnValue(NEW_SECRET);

    await rotateWebhookSecret(
      { tenantId: TENANT, source: 'eventcreate', actorUserId: ACTOR, now },
      { repo, audit, generateSecret },
    );

    expect(generateSecret).toHaveBeenCalledTimes(1);
    expect(rotateSecret.mock.calls[0]![0].newActiveSecret).toBe(NEW_SECRET);
  });
});
