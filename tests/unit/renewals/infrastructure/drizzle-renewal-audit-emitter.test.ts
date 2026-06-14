/**
 * F8 Phase 3 Round 3 (CR1/CR2 behavioural test) — `drizzle-renewal-audit-emitter`.
 *
 * Verifies the four pre-flight + DB-fault paths that protect the audit
 * trail invariant (Constitution Principle VIII):
 *
 *   1. unknown event type → `pinoFallback` reason=unknown_event_type, no DB insert
 *   2. shipped-but-not-in-pgenum → `pinoFallback` reason=not_in_pgenum, no DB insert
 *   3. NODE_ENV=production → `pinoFallback` THROWS so emit-site drift is loud
 *   4. shipped event + DB insert fails → fire-and-forget swallows + logs forensics
 *
 * Plus the two pre-flight throws for `emitInTx` (unknown event type +
 * not-yet-in-pgenum) — `emitInTx` MUST throw (not swallow) so the
 * surrounding state mutation rolls back. The DB-fault rollback path
 * for `emitInTx` is exercised at the use-case level (cancel-cycle.ts +
 * mark-paid-offline.ts integration tests), not here, since this unit
 * test mocks `runInTenant` and does not represent a real Postgres tx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditContext,
  F8AuditEvent,
  F8AuditEventType,
} from '@/modules/renewals/application/ports/renewal-audit-emitter';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { asMemberId } from '@/modules/members';

// Mock `runInTenant` so we can drive the DB-insert success/failure path
// without a real Postgres connection.
const runInTenantMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {} as unknown,
  runInTenant: (...args: unknown[]) => runInTenantMock(...args),
}));

// Schema import is type-only; we don't need a real auditLog object — the
// tx.insert call is short-circuited by the mocked runInTenant.
vi.mock('@/modules/auth/infrastructure/db/schema', () => ({
  auditLog: { __mockTable: true },
}));

import { makeDrizzleRenewalAuditEmitter } from '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter';

const tenant = {
  tenantId: 'tenant-a',
  __brand: 'TenantContext',
} as unknown as TenantContext;

const ctx: AuditContext = {
  tenantId: 'tenant-a',
  actorUserId: '00000000-0000-0000-0000-000000000001',
  actorRole: 'admin',
  correlationId: 'corr-1',
  requestId: 'req-1',
};

const SHIPPED_EVENT: F8AuditEvent<'renewal_cycle_cancelled'> = {
  type: 'renewal_cycle_cancelled',
  payload: {
    cycle_id: asCycleId('00000000-0000-0000-0000-000000000aaa'),
    member_id: asMemberId('member-1'),
    reason: 'admin requested',
    previous_status: 'upcoming',
  },
};

const NOT_IN_PGENUM_EVENT: F8AuditEvent<'renewal_payment_failed'> = {
  // Valid F8 event type but deliberately NOT in F8_ENUM_SHIPPED — the
  // only remaining `_F8_ENUM_DEFERRED` reservation after F8-completion
  // slice 1 shipped `renewal_cycle_created` (F5→F8 payment_failed
  // listener bridge is still post-MVP / OOS-18).
  type: 'renewal_payment_failed',
  payload: {},
};

const UNKNOWN_EVENT = {
  type: 'totally_made_up_event_type' as F8AuditEventType,
  payload: { foo: 'bar' },
} as F8AuditEvent;

describe('makeDrizzleRenewalAuditEmitter — emit() (fire-and-forget)', () => {
  beforeEach(() => {
    runInTenantMock.mockReset();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.spyOn(logger, 'error').mockImplementation(() => logger);
    vi.stubEnv('NODE_ENV', 'test');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('unknown event type — pinoFallback with reason=unknown_event_type, no DB call, no throw', async () => {
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    await expect(emitter.emit(UNKNOWN_EVENT, ctx)).resolves.toBeUndefined();
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        f8AuditFallthrough: true,
        reason: 'unknown_event_type',
        eventType: 'totally_made_up_event_type',
      }),
      expect.stringContaining('event type not in pgEnum'),
    );
  });

  it('not-yet-in-pgenum event (renewal_payment_failed) — pinoFallback with reason=not_in_pgenum', async () => {
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    await expect(
      emitter.emit(NOT_IN_PGENUM_EVENT, ctx),
    ).resolves.toBeUndefined();
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'not_in_pgenum',
        eventType: 'renewal_payment_failed',
      }),
      expect.any(String),
    );
  });

  it('NODE_ENV=production + un-shipped event — pinoFallback THROWS so emit-site drift is loud', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    // The throw must propagate through emit() because pre-flight is OUTSIDE
    // the try/catch (CR1). Without CR1 this would be silently swallowed.
    await expect(emitter.emit(NOT_IN_PGENUM_EVENT, ctx)).rejects.toThrow(
      /audit emit fell through to pino in production/,
    );
    expect(runInTenantMock).not.toHaveBeenCalled();
  });

  it('shipped event + DB insert fails — fire-and-forget swallows + logs forensic context', async () => {
    runInTenantMock.mockRejectedValueOnce(new Error('connection reset'));
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    await expect(emitter.emit(SHIPPED_EVENT, ctx)).resolves.toBeUndefined();
    expect(runInTenantMock).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'renewal_cycle_cancelled',
        tenantId: 'tenant-a',
        actorUserId: '00000000-0000-0000-0000-000000000001',
        correlationId: 'corr-1',
        requestId: 'req-1',
        payloadKeys: expect.arrayContaining([
          'cycle_id',
          'member_id',
          'reason',
          'previous_status',
        ]),
      }),
      expect.stringContaining('DB insert failed'),
    );
  });

  it('shipped event + DB insert succeeds — runInTenant invoked, no log', async () => {
    runInTenantMock.mockResolvedValueOnce(undefined);
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    await emitter.emit(SHIPPED_EVENT, ctx);
    expect(runInTenantMock).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Round-5 review-finding L3: pin every newly-whitelisted shipped
  // event so a future regression that drops one from
  // `F8_ENUM_SHIPPED_TUPLE` (the catalogue → whitelist drift the
  // round-4 review surfaced) fails the suite at the boundary
  // between Round-3 closure and any future shipping commit.
  it.each([
    'cron_bearer_auth_rejected',
    'renewal_kill_switch_blocked',
    'lapsed_member_action_blocked',
    'renewal_cross_member_probe',
    // F8-completion slice 1 — moved deferred→shipped (whitelist MOVE, no
    // migration; the pgEnum value already exists from migration 0109).
    'renewal_cycle_created',
  ] as const)(
    'round-3+4 shipped event %s — runs DB-insert path under NODE_ENV=production',
    async (eventType) => {
      vi.stubEnv('NODE_ENV', 'production');
      runInTenantMock.mockResolvedValueOnce(undefined);
      const emitter = makeDrizzleRenewalAuditEmitter(tenant);
      // Cast: payload shape varies per event type; at this layer we
      // only verify the event is in F8_ENUM_SHIPPED (drives runInTenant
      // path, NOT the pinoFallback throw branch). The audit-payload
      // schema tests pin the per-event payload shape elsewhere.
      await emitter.emit({ type: eventType, payload: {} } as never, ctx);
      expect(runInTenantMock).toHaveBeenCalledOnce();
    },
  );
});

describe('makeDrizzleRenewalAuditEmitter — emitInTx() (atomic, throws-on-failure)', () => {
  beforeEach(() => {
    runInTenantMock.mockReset();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    vi.stubEnv('NODE_ENV', 'test');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('unknown event type — pinoFallback + THROWS so caller tx rolls back', async () => {
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    // J6-H6: emitInTx now requires `tx: TenantTx` (Drizzle pg-tx).
    // Tests don't have a real tx so we double-cast through unknown.
    const fakeTx = { insert: vi.fn() } as unknown as TenantTx;
    await expect(emitter.emitInTx(fakeTx, UNKNOWN_EVENT, ctx)).rejects.toThrow(
      /not a known F8 audit event/,
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('not-yet-in-pgenum event — pinoFallback + THROWS', async () => {
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    // J6-H6: emitInTx now requires `tx: TenantTx` (Drizzle pg-tx).
    // Tests don't have a real tx so we double-cast through unknown.
    const fakeTx = { insert: vi.fn() } as unknown as TenantTx;
    await expect(
      emitter.emitInTx(fakeTx, NOT_IN_PGENUM_EVENT, ctx),
    ).rejects.toThrow(/not yet in the audit_event_type pgEnum/);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('shipped event — inserts via supplied tx (no runInTenant)', async () => {
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });
    const fakeTx = { insert: insertMock } as unknown as TenantTx;
    const emitter = makeDrizzleRenewalAuditEmitter(tenant);
    await emitter.emitInTx(fakeTx, SHIPPED_EVENT, ctx);
    expect(insertMock).toHaveBeenCalledOnce();
    expect(runInTenantMock).not.toHaveBeenCalled();
  });
});
