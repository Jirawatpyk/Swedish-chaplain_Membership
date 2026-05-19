/**
 * Unit tests for the `generateWebhookSecret` use-case (T070).
 *
 * Covers:
 *   - happy path → inserts row + emits `webhook_secret_generated`
 *     audit + returns `{secret, secretLastFour}`
 *   - already_exists from repo → maps to `secret_already_exists` error
 *     (no audit emitted on this branch — caller must rotate)
 *   - repo `db_error` short-circuits BEFORE the audit emit
 *   - audit emit failure surfaces `audit_emit_failed` + logger.fatal
 *     fires for forensic trail
 *   - `actorUserId` + `now` + `secretLastFour` forwarded verbatim to
 *     repo + audit
 *   - `generateSecret` factory result threaded into `repo.insert` +
 *     audit `secretLastFour` (defensive against future plumbing
 *     regressions)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { logger } from '@/lib/logger';
import { generateWebhookSecret } from '@/modules/events/application/use-cases/generate-webhook-secret';
import type {
  TenantWebhookConfigRepository,
} from '@/modules/events/application/ports/tenant-webhook-config-repository';
import type { F6AuditPort } from '@/modules/events/application/ports/audit-port';
import type { TenantId } from '@/modules/members';
import type { UserId, AuditEventId } from '@/modules/auth';
import type { WebhookSecret } from '@/modules/events';
import type { TenantWebhookConfigAggregate } from '@/modules/events';

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
const FIXTURE_SECRET = 'whsec_fixture_value_with_clearly_visible_last_four_1a2b' as WebhookSecret;

function makeAggregate(secret: WebhookSecret): TenantWebhookConfigAggregate {
  return {
    tenantId: TENANT,
    source: 'eventcreate',
    activeSecret: secret,
    grace: { active: false } as const,
    enabled: true,
    createdAt: new Date('2026-05-13T00:00:00Z'),
    lastReceivedAt: null,
    lastRotatedAt: null,
  };
}

describe('generateWebhookSecret', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  });

  it('happy — inserts row + emits webhook_secret_generated audit + returns secret + lastFour', async () => {
    const insert = vi.fn().mockResolvedValue(ok(makeAggregate(FIXTURE_SECRET)));
    const auditEmit = vi.fn().mockResolvedValue(ok('audit-id' as AuditEventId));
    const repo = makeRepo({ insert });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(FIXTURE_SECRET);

    const now = new Date('2026-05-13T10:00:00.000Z');
    const result = await generateWebhookSecret(
      { tenantId: TENANT, source: 'eventcreate', actorUserId: ACTOR, now },
      { repo, audit, generateSecret },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.secret).toBe(FIXTURE_SECRET);
    expect(result.value.secretLastFour).toBe('1a2b');

    expect(insert).toHaveBeenCalledWith({
      tenantId: TENANT,
      source: 'eventcreate',
      activeSecret: FIXTURE_SECRET,
    });
    expect(auditEmit).toHaveBeenCalledTimes(1);
    const entry = auditEmit.mock.calls[0]![0];
    expect(entry.eventType).toBe('webhook_secret_generated');
    expect(entry.actorType).toBe('admin');
    expect(entry.actorUserId).toBe(ACTOR);
    expect(entry.tenantId).toBe(TENANT);
    expect(entry.occurredAt).toBe(now);
    expect(entry.payload.secretLastFour).toBe('1a2b');
    expect(entry.payload.actorUserId).toBe(ACTOR);
    expect(entry.payload.severity).toBe('info');
    // Audit summary MUST NOT carry the plaintext secret (only last4).
    expect(entry.summary).not.toContain(FIXTURE_SECRET);
    expect(entry.summary).toContain('1a2b');
  });

  it('already_exists from repo → returns secret_already_exists (no audit emitted)', async () => {
    const insert = vi.fn().mockResolvedValue(
      err({ kind: 'already_exists' as const, tenantId: TENANT, source: 'eventcreate' as const }),
    );
    const auditEmit = vi.fn();
    const repo = makeRepo({ insert });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(FIXTURE_SECRET);

    const result = await generateWebhookSecret(
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
    expect(result.error.kind).toBe('secret_already_exists');
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it('repo db_error short-circuits BEFORE audit emit', async () => {
    const insert = vi.fn().mockResolvedValue(
      err({ kind: 'db_error' as const, message: 'connection lost' }),
    );
    const auditEmit = vi.fn();
    const repo = makeRepo({ insert });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(FIXTURE_SECRET);

    const result = await generateWebhookSecret(
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
    expect(auditEmit).not.toHaveBeenCalled();
  });

  it('audit emit failure → audit_emit_failed + logger.fatal fires', async () => {
    const insert = vi.fn().mockResolvedValue(ok(makeAggregate(FIXTURE_SECRET)));
    const auditEmit = vi.fn().mockResolvedValue(
      err({ kind: 'db_error' as const, message: 'audit table unreachable' }),
    );
    const repo = makeRepo({ insert });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(FIXTURE_SECRET);
    const fatalSpy = vi.spyOn(logger, 'fatal');

    const result = await generateWebhookSecret(
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
    expect(result.error.kind).toBe('audit_emit_failed');
    expect(fatalSpy).toHaveBeenCalledTimes(1);
    const fatalArgs = fatalSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(fatalArgs['event']).toBe('f6_generate_secret_audit_emit_failed');
    expect(fatalArgs['secretLastFour']).toBe('1a2b');
    // CRITICAL: the fatal log must NOT carry the plaintext secret.
    expect(JSON.stringify(fatalArgs)).not.toContain(FIXTURE_SECRET);
  });

  it('generateSecret factory invoked once and result threaded into insert + audit', async () => {
    const insert = vi.fn().mockResolvedValue(ok(makeAggregate(FIXTURE_SECRET)));
    const auditEmit = vi.fn().mockResolvedValue(ok('audit-id' as AuditEventId));
    const repo = makeRepo({ insert });
    const audit = makeAudit({ emit: auditEmit });
    const generateSecret = vi.fn().mockReturnValue(FIXTURE_SECRET);

    await generateWebhookSecret(
      {
        tenantId: TENANT,
        source: 'eventcreate',
        actorUserId: ACTOR,
        now: new Date(),
      },
      { repo, audit, generateSecret },
    );

    expect(generateSecret).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]![0].activeSecret).toBe(FIXTURE_SECRET);
  });
});
