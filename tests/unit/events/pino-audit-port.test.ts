/**
 * Unit tests for `pino-audit-port` covering the in-tx `emit` and
 * separate-tx `emitRolledBack` paths' `logFullError` invocations.
 *
 * Integration test `emit-standalone.test.ts` exercises the
 * `emitStandalone` caller's `logFullError` via a real slug-guard
 * throw + live Neon Singapore connection. These unit tests close the
 * remaining 2 callers (`emit` + `emitRolledBack`) without requiring
 * DB unavailability — mock the executor / `db.transaction` so the
 * try/catch surfaces the `logFullError` shape.
 *
 * What's verified:
 *   - `emit` catch invokes logger.error with
 *     `event:'f6_audit_emit_db_error', caller:'emit'` + structured err
 *   - `emitRolledBack` catch invokes logger.error with
 *     `caller:'emitRolledBack'` + structured err
 *   - Sanitised result message reaches Result.err for both paths
 *   - `audit_secondary_tx_failure: true` marker on `emitRolledBack`
 *     pino.fatal fallback
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import type { TenantTx } from '@/lib/db';
import type { F6AuditEntry } from '@/modules/events/application/ports/audit-port';

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    db: {
      transaction: vi.fn(),
    },
  };
});

const VALID_ENTRY: F6AuditEntry<'webhook_rolled_back'> = {
  eventType: 'webhook_rolled_back',
  tenantId: 'test-chamber' as F6AuditEntry<'webhook_rolled_back'>['tenantId'],
  actorType: 'zapier_webhook',
  actorUserId: null,
  occurredAt: new Date(),
  summary: 'unit test rolled-back entry',
  payload: {
    severity: 'error',
    requestId: 'req-unit-test',
    source: 'eventcreate',
    failureStage: 'unknown',
    errorMessage: 'unit-test forced failure',
    errorStack: null,
  },
};

describe('pino-audit-port — logFullError coverage on emit + emitRolledBack', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fatalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    fatalSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    fatalSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('emit (in-tx) — executor.execute throw → logFullError with caller="emit" + sanitised Result.err', async () => {
    const executor = {
      execute: vi.fn().mockRejectedValue(
        new Error('relation "audit_log" does not exist'),
      ),
    } as unknown as TenantTx;
    const port = makePinoAuditPort(executor);

    const result = await port.emit(VALID_ENTRY);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    if (result.error.kind !== 'db_error') throw new Error('unreachable');
    // Sanitiser strips `"audit_log"` identifier
    expect(result.error.message).toMatch(/relation\s+"\[redacted\]"/);

    // logFullError preserves the unsanitised name + message + stack
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_audit_emit_db_error',
        caller: 'emit',
        tenantId: 'test-chamber',
        eventType: 'webhook_rolled_back',
        err: expect.objectContaining({
          name: expect.any(String),
          message: expect.stringContaining('audit_log'),
          stack: expect.any(String),
        }),
      }),
      expect.any(String),
    );
  });

  it('emitRolledBack — db.transaction throw → logFullError with caller="emitRolledBack" + audit_secondary_tx_failure marker', async () => {
    const { db } = await import('@/lib/db');
    vi.mocked(db.transaction).mockRejectedValue(
      new Error('column "tenant_id" of constraint "audit_log_pkey" violation'),
    );

    // Dummy executor — emitRolledBack uses root db.transaction not this
    const executor = {
      execute: () => {
        throw new Error('not reached');
      },
    } as unknown as TenantTx;
    const port = makePinoAuditPort(executor);

    const result = await port.emitRolledBack(VALID_ENTRY);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    if (result.error.kind !== 'db_error') throw new Error('unreachable');
    expect(result.error.message).toMatch(/column\s+"\[redacted\]"/);

    // logFullError preserves the unsanitised name + message + stack
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_audit_emit_db_error',
        caller: 'emitRolledBack',
        tenantId: 'test-chamber',
        eventType: 'webhook_rolled_back',
        err: expect.objectContaining({
          name: expect.any(String),
          message: expect.stringContaining('tenant_id'),
          stack: expect.any(String),
        }),
      }),
      expect.any(String),
    );

    // pino.fatal secondary-tx-failure marker fires per FR-037 dual-write fallback
    expect(fatalSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'webhook_rolled_back',
        audit_secondary_tx_failure: true,
        tenantId: 'test-chamber',
      }),
      expect.stringContaining('audit secondary-tx failure'),
    );
  });

  it('emitRolledBack — invalid tenantId fails slug-guard regex → logFullError with caller="emitRolledBack"', async () => {
    const executor = {
      execute: () => {
        throw new Error('not reached');
      },
    } as unknown as TenantTx;
    const port = makePinoAuditPort(executor);

    const result = await port.emitRolledBack({
      ...VALID_ENTRY,
      tenantId: "evil'; DROP TABLE audit_log; --" as unknown as F6AuditEntry<'webhook_rolled_back'>['tenantId'],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('db_error');
    if (result.error.kind !== 'db_error') throw new Error('unreachable');
    expect(result.error.message).toMatch(/slug invariant violated/);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_audit_emit_db_error',
        caller: 'emitRolledBack',
        err: expect.objectContaining({
          message: expect.stringContaining('slug invariant violated'),
        }),
      }),
      expect.any(String),
    );
  });
});

/**
 * Phase 6 staff-review-4 Round 6 ARCH-R6-02 closure — direct unit
 * coverage for the `emitMatchingQuotaMetric` dispatcher hidden inside
 * `pino-audit-port.ts:65-121`. Round 5 already shipped the 4 OTel
 * counter declarations + the dispatcher hook in `emit()`, but the
 * dispatcher itself had NO direct test coverage. A future refactor
 * dropping a switch-case arm (e.g., renaming `quota_credit_back_refund`
 * to `quota_credit_back_payment_refund`) would silently stop firing
 * the counter — no test would fail because the `safeMetric` wrapper
 * absorbs failures and the integration tests assert audit rows, not
 * OTel counter values.
 *
 * The dispatcher fires from a switch on `entry.eventType`. We spy on
 * `eventcreateMetrics.*` and feed each quota event-type through `emit()`
 * to assert the right counter is incremented with the right labels.
 * The `default` case is verified by feeding a non-quota event through
 * `emit()` and asserting NO counter fired.
 */
describe('emitMatchingQuotaMetric — ARCH-R6-02 direct dispatcher coverage', () => {
  let executor: TenantTx;
  let partnershipSpy: ReturnType<typeof vi.spyOn>;
  let culturalSpy: ReturnType<typeof vi.spyOn>;
  let creditBackSpy: ReturnType<typeof vi.spyOn>;
  let overQuotaSpy: ReturnType<typeof vi.spyOn>;
  let webhookReceiptsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Stub the executor.execute → returns an audit_log RETURNING id row
    // matching `insertAuditRow` shape (`rows[0].id`) so the success path
    // runs to completion, allowing emitMatchingQuotaMetric to fire.
    executor = {
      execute: vi.fn().mockResolvedValue([{ id: 'audit-test-id' }]),
    } as unknown as TenantTx;

    // Spy on every counter the dispatcher may fire. Match the actual
    // names declared in `src/lib/metrics.ts` to fail if names drift.
    const metrics = await import('@/lib/metrics');
    partnershipSpy = vi
      .spyOn(metrics.eventcreateMetrics, 'quotaPartnershipDecremented')
      .mockImplementation(() => {});
    culturalSpy = vi
      .spyOn(metrics.eventcreateMetrics, 'quotaCulturalDecremented')
      .mockImplementation(() => {});
    creditBackSpy = vi
      .spyOn(metrics.eventcreateMetrics, 'quotaCreditBack')
      .mockImplementation(() => {});
    overQuotaSpy = vi
      .spyOn(metrics.eventcreateMetrics, 'quotaOverQuotaWarning')
      .mockImplementation(() => {});
    // Webhook-receipts counter — used to verify the dispatcher's
    // `default: break` arm does NOT accidentally fire it.
    webhookReceiptsSpy = vi
      .spyOn(metrics.eventcreateMetrics, 'webhookReceiptsTotal')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('quota_partnership_decremented → fires quotaPartnershipDecremented with plan_tier=null', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_partnership_decremented',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'unit-test partnership decrement',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        eventId: 'evt-1' as never,
        perEventAllotmentBefore: 6,
        perEventAllotmentAfter: 5,
      },
    });
    expect(partnershipSpy).toHaveBeenCalledTimes(1);
    expect(partnershipSpy).toHaveBeenCalledWith('test-chamber', null);
    expect(culturalSpy).not.toHaveBeenCalled();
    expect(creditBackSpy).not.toHaveBeenCalled();
    expect(overQuotaSpy).not.toHaveBeenCalled();
  });

  it('quota_cultural_decremented → fires quotaCulturalDecremented with plan_tier=null', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_cultural_decremented',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'unit-test cultural decrement',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        eventId: 'evt-1' as never,
        fiscalYear: 2026,
        annualAllotmentBefore: 2,
        annualAllotmentAfter: 1,
      },
    });
    expect(culturalSpy).toHaveBeenCalledTimes(1);
    expect(culturalSpy).toHaveBeenCalledWith('test-chamber', null);
    expect(partnershipSpy).not.toHaveBeenCalled();
  });

  it('quota_over_quota_warning → fires quotaOverQuotaWarning with scope from payload', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_over_quota_warning',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'over-quota partnership',
      payload: {
        severity: 'warn',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        eventId: 'evt-1' as never,
        scope: 'partnership',
        allotmentAtIngest: 0,
      },
    });
    expect(overQuotaSpy).toHaveBeenCalledTimes(1);
    expect(overQuotaSpy).toHaveBeenCalledWith('test-chamber', 'partnership');
    expect(partnershipSpy).not.toHaveBeenCalled();
  });

  it('quota_credit_back_refund → fires quotaCreditBack with cause="refund"', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_credit_back_refund',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'refund credit-back',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        scope: 'cultural',
        allotmentAfter: 2,
      },
    });
    expect(creditBackSpy).toHaveBeenCalledTimes(1);
    expect(creditBackSpy).toHaveBeenCalledWith('test-chamber', 'refund', 'cultural');
  });

  it('quota_credit_back_archive → fires quotaCreditBack with cause="archive"', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_credit_back_archive',
      tenantId: 'test-chamber' as never,
      actorType: 'admin',
      actorUserId: 'u-1' as never,
      occurredAt: new Date(),
      summary: 'archive credit-back',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        scope: 'partnership',
        allotmentAfter: 6,
      },
    });
    expect(creditBackSpy).toHaveBeenCalledTimes(1);
    expect(creditBackSpy).toHaveBeenCalledWith('test-chamber', 'archive', 'partnership');
  });

  it('default arm — non-quota event (event_archived macro) fires NO quota counter', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'event_archived',
      tenantId: 'test-chamber' as never,
      actorType: 'admin',
      actorUserId: 'u-1' as never,
      occurredAt: new Date(),
      summary: 'event archived macro',
      payload: {
        severity: 'info',
        actorUserId: 'u-1' as never,
        eventId: 'evt-1' as never,
        registrationsAffected: 3,
        quotaReversals: { partnership: 2, cultural: 1 },
      },
    });
    expect(partnershipSpy).not.toHaveBeenCalled();
    expect(culturalSpy).not.toHaveBeenCalled();
    expect(creditBackSpy).not.toHaveBeenCalled();
    expect(overQuotaSpy).not.toHaveBeenCalled();
    expect(webhookReceiptsSpy).not.toHaveBeenCalled();
  });

  it('insertAuditRow failure — dispatcher does NOT fire any counter (Result.err short-circuit)', async () => {
    const failingExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('simulated db_error')),
    } as unknown as TenantTx;
    const port = makePinoAuditPort(failingExecutor);
    const result = await port.emit({
      eventType: 'quota_partnership_decremented',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'unit-test partnership decrement (will fail)',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        eventId: 'evt-1' as never,
        perEventAllotmentBefore: 6,
        perEventAllotmentAfter: 5,
      },
    });
    expect(result.ok).toBe(false);
    expect(partnershipSpy).not.toHaveBeenCalled();
  });

  it('TEST-FR-01 — planTier label flows from payload to quotaPartnershipDecremented counter', async () => {
    // R7 TEST-FR-01 closure — the previous 5 dispatcher tests all
    // emit with planTier=null (payload omits it). This test pins the
    // PERF-05 flow-through: payload.planTier='diamond' must reach the
    // counter as the second positional arg. A regression dropping the
    // payload-read in `emitMatchingQuotaMetric` would silently degrade
    // the OTel `plan_tier` label to 'unknown' across all SweCham
    // traffic, invalidating the per-tier dashboard.
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_partnership_decremented',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'partnership decrement with tier label',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        eventId: 'evt-1' as never,
        perEventAllotmentBefore: 6,
        perEventAllotmentAfter: 5,
        planTier: 'diamond',
      },
    });
    expect(partnershipSpy).toHaveBeenCalledTimes(1);
    expect(partnershipSpy).toHaveBeenCalledWith('test-chamber', 'diamond');
  });

  it('TEST-FR-01 — planTier label flows from payload to quotaCulturalDecremented counter', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_cultural_decremented',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'cultural decrement with tier label',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        eventId: 'evt-1' as never,
        fiscalYear: 2026,
        annualAllotmentBefore: 2,
        annualAllotmentAfter: 1,
        planTier: 'premium',
      },
    });
    expect(culturalSpy).toHaveBeenCalledTimes(1);
    expect(culturalSpy).toHaveBeenCalledWith('test-chamber', 'premium');
  });

  it('TEST-FR-06 — emitStandalone path ALSO fires the matching counter (PERF-R6-03 closure)', async () => {
    // R7 TEST-FR-06 closure — PERF-R6-03 wired `emitMatchingQuotaMetric`
    // into BOTH `emit()` AND `emitStandalone()`. Existing 5 dispatcher
    // tests only exercise `emit()`. A future refactor dropping the
    // emitStandalone callsite would silently stop firing counters for
    // any standalone quota emit (e.g., F6.1 manual recovery scripts).
    //
    // emitStandalone uses `db.transaction(...)` — mock the root db's
    // transaction method to invoke the callback with a passthrough
    // executor that returns the audit row id.
    const { db } = await import('@/lib/db');
    const dbTxSpy = vi.spyOn(db, 'transaction').mockImplementation(
      // @ts-expect-error — minimal stub matches the runtime callback shape
      (async (cb) => {
        // Always return the audit row shape — the SET LOCAL calls
        // don't read the return value, only the final INSERT does.
        // Returning the same shape for every execute() call is safe
        // because the SET LOCALs' return is discarded by insertAuditRow.
        const tx = {
          execute: vi.fn().mockResolvedValue([{ id: 'audit-test-id' }]),
        } as unknown as TenantTx;
        return cb(tx);
      }) as never,
    );

    const port = makePinoAuditPort(executor);
    await port.emitStandalone({
      eventType: 'quota_credit_back_archive',
      tenantId: 'test-chamber' as never,
      actorType: 'admin',
      actorUserId: 'u-1' as never,
      occurredAt: new Date(),
      summary: 'standalone archive credit-back',
      payload: {
        severity: 'info',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        scope: 'partnership',
        allotmentAfter: 4,
      },
    });

    expect(creditBackSpy).toHaveBeenCalledTimes(1);
    expect(creditBackSpy).toHaveBeenCalledWith('test-chamber', 'archive', 'partnership');
    dbTxSpy.mockRestore();
  });

  it('invalid scope in payload — over-quota dispatcher skips counter (defensive guard)', async () => {
    const port = makePinoAuditPort(executor);
    await port.emit({
      eventType: 'quota_over_quota_warning',
      tenantId: 'test-chamber' as never,
      actorType: 'zapier_webhook',
      actorUserId: null,
      occurredAt: new Date(),
      summary: 'malformed scope',
      payload: {
        severity: 'warn',
        registrationId: 'reg-1' as never,
        memberId: 'mem-1' as never,
        eventId: 'evt-1' as never,
        // @ts-expect-error — intentional invalid scope to test guard
        scope: 'invalid-scope',
        allotmentAtIngest: 0,
      },
    });
    // Dispatcher's `if (scope === 'partnership' || scope === 'cultural')`
    // guard rejects unknown values → counter does NOT fire.
    expect(overQuotaSpy).not.toHaveBeenCalled();
  });
});

describe('F6_DEFAULT_RETENTION_YEARS — staff-review R6-W6 guard (2026-05-13)', () => {
  it('is exactly 5 years', async () => {
    // R6-W6 staff-review fix (2026-05-13): retention is hardcoded at
    // the Infrastructure layer (pino-audit-port.insertAuditRow line
    // 104) rather than threaded through the AuditEntry envelope. A
    // future edit that silently bumped this to 10 (analogy with F4
    // tax-document upgrade) would land without a spec amendment.
    // This guard makes the constant a load-bearing assertion: any
    // change to the retention floor MUST update this test in lockstep,
    // forcing a Spec Kit ticket + reviewer awareness.
    //
    // PDPA/GDPR data-minimisation rationale: F6 audit events cover
    // attendee ingest + admin actions on attendee records. The 5y
    // floor matches F1/F2/F3/F5/F7/F8 defaults; F4 (tax docs) is the
    // sole 10y exception per Thai Revenue Code §87/3.
    const mod = await import('@/modules/events/infrastructure/pino-audit-port');
    expect(mod.F6_DEFAULT_RETENTION_YEARS).toBe(5);
  });
});
