/**
 * Unit tests for `updateFeeConfig` use case (T145, US5 FR-017).
 *
 * Covers all error paths + idempotent no-op + happy paths (vat_rate change,
 * registration_fee change, currency change when 0 plans) at 100%
 * line/branch/function coverage.
 *
 * The `feeConfigRepo.update` mock is used for vat_rate / registration_fee
 * changes; `feeConfigRepo.upsert` is NOT called by this use case (the
 * source uses `update` for all field changes including currency when allowed).
 *
 * Live Neon coverage is in `tests/integration/plans/update-fee-config.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  updateFeeConfig,
  type UpdateFeeConfigDeps,
  type UpdateFeeConfigInput,
} from '@/modules/plans/application/update-fee-config';
import { asTenantContext } from '@/modules/tenants';
import type { TenantFeeConfig } from '@/modules/plans/domain/fee-config';
import type { TenantSlug } from '@/modules/plans/domain/plan';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tenant = asTenantContext('swecham');

function makeFeeConfig(overrides: Partial<TenantFeeConfig> = {}): TenantFeeConfig {
  return {
    tenant_id: 'swecham' as TenantSlug,
    currency_code: 'THB',
    vat_rate: 0.07,
    registration_fee_minor_units: 100_000,
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_by: 'seed-user',
    ...overrides,
  };
}

const baseInput: UpdateFeeConfigInput = {
  patch: { vat_rate: 0.07 },
  actorUserId: 'actor-user-uuid',
  requestId: 'req-fee-001',
  sourceIp: '10.0.0.1',
  idempotencyKey: 'idempotency-key-fee-001',
};

// ---------------------------------------------------------------------------
// Dependency factory
// ---------------------------------------------------------------------------

type DepsOverrides = {
  /** Pass `Error` to make findByTenant throw, `null` to return undefined, or a TenantFeeConfig to return it. Omit for default makeFeeConfig(). */
  currentConfig?: TenantFeeConfig | null | Error;
  /** Pass `Error` to make update throw, `null` to return undefined, or a TenantFeeConfig to return it. Omit for a default updated config. */
  updateResult?: TenantFeeConfig | null | Error;
  countActiveForTenantResult?: number | Error;
  auditFail?: boolean;
};

function makeDeps(overrides: DepsOverrides = {}): UpdateFeeConfigDeps {
  const feeConfigRepo = {
    findByTenant: vi.fn(async (): Promise<TenantFeeConfig | undefined> => {
      if (overrides.currentConfig instanceof Error) throw overrides.currentConfig;
      if (overrides.currentConfig === null) return undefined;
      return overrides.currentConfig ?? makeFeeConfig();
    }),
    update: vi.fn(async (): Promise<TenantFeeConfig | undefined> => {
      if (overrides.updateResult instanceof Error) throw overrides.updateResult;
      if (overrides.updateResult === null) return undefined;
      return overrides.updateResult ?? makeFeeConfig({ vat_rate: 0.1, updated_by: 'actor-user-uuid' });
    }),
    upsert: vi.fn(),
  };

  const planRepo = {
    countActiveForTenant: vi.fn(async () => {
      const r = overrides.countActiveForTenantResult;
      if (r instanceof Error) throw r;
      return r ?? 0;
    }),
    findByTenantAndYear: vi.fn(),
    findOne: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    softDelete: vi.fn(),
    undelete: vi.fn(),
    cloneYear: vi.fn(),
  };

  const audit = {
    record: vi.fn(async () => {
      if (overrides.auditFail) {
        return err({ type: 'persist_failed' as const, message: 'audit write error' });
      }
      return ok(undefined as void);
    }),
  };

  const clock = {
    now: vi.fn(() => new Date('2026-04-17T12:00:00.000Z')),
    currentYear: vi.fn(() => 2026),
  };

  const members = {
    countActivePlanMembers: vi.fn(async () => 0),
  };

  return {
    tenant,
    planRepo,
    feeConfigRepo,
    audit,
    clock,
    members,
  } as unknown as UpdateFeeConfigDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updateFeeConfig use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Step 1: feeConfigRepo.findByTenant error paths ---------------------

  it('returns server_error when feeConfigRepo.findByTenant throws', async () => {
    const deps = makeDeps({ currentConfig: new Error('DB timeout') });
    const result = await updateFeeConfig(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('DB timeout');
      }
    }
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
  });

  it('returns server_error with string coercion when feeConfigRepo.findByTenant throws non-Error', async () => {
    const feeConfigRepo = {
      findByTenant: vi.fn(async () => { throw 'raw string error'; }),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    const deps = { ...makeDeps(), feeConfigRepo } as unknown as UpdateFeeConfigDeps;
    const result = await updateFeeConfig(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('raw string error');
      }
    }
  });

  it('returns not_found when feeConfigRepo.findByTenant returns undefined', async () => {
    const deps = makeDeps({ currentConfig: null });
    const result = await updateFeeConfig(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_found');
    }
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
  });

  // ---- Step 2: zod validation error paths ---------------------------------

  it('returns invalid_body when vat_rate is >= 1', async () => {
    const deps = makeDeps();
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 1.0 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
      if (result.error.type === 'invalid_body') {
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues[0]).toContain('vat_rate');
      }
    }
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
  });

  it('returns invalid_body when vat_rate is negative', async () => {
    const deps = makeDeps();
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: -0.01 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
  });

  it('returns invalid_body when registration_fee_minor_units is a float', async () => {
    const deps = makeDeps();
    const result = await updateFeeConfig(
      { ...baseInput, patch: { registration_fee_minor_units: 100.5 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
      if (result.error.type === 'invalid_body') {
        expect(result.error.issues[0]).toContain('registration_fee_minor_units');
      }
    }
  });

  it('returns invalid_body when registration_fee_minor_units is negative', async () => {
    const deps = makeDeps();
    const result = await updateFeeConfig(
      { ...baseInput, patch: { registration_fee_minor_units: -1 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
  });

  it('returns invalid_body when currency_code is not a supported ISO 4217 code', async () => {
    const deps = makeDeps();
    const result = await updateFeeConfig(
      { ...baseInput, patch: { currency_code: 'XYZ' } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
      if (result.error.type === 'invalid_body') {
        expect(result.error.issues[0]).toContain('currency_code');
      }
    }
  });

  it('returns invalid_body for unknown keys (strict schema)', async () => {
    const deps = makeDeps();
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.07, unknownField: 'boom' } as never },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_body');
    }
  });

  // ---- Step 3: currency immutability guard --------------------------------

  it('returns currency_code_immutable_in_f2 when plans exist and currency differs', async () => {
    const deps = makeDeps({ countActiveForTenantResult: 3 });
    const result = await updateFeeConfig(
      { ...baseInput, patch: { currency_code: 'SEK' } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('currency_code_immutable_in_f2');
      if (result.error.type === 'currency_code_immutable_in_f2') {
        expect(result.error.current_currency_code).toBe('THB');
        expect(result.error.attempted_currency_code).toBe('SEK');
        expect(result.error.non_deleted_plan_count).toBe(3);
      }
    }
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
  });

  it('returns server_error when planRepo.countActiveForTenant throws during currency guard', async () => {
    const deps = makeDeps({ countActiveForTenantResult: new Error('Plans DB unreachable') });
    const result = await updateFeeConfig(
      { ...baseInput, patch: { currency_code: 'SEK' } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('Plans DB unreachable');
      }
    }
  });

  it('returns server_error with string coercion when planRepo.countActiveForTenant throws non-Error', async () => {
    const planRepo = {
      countActiveForTenant: vi.fn(async () => { throw 99; }),
      findByTenantAndYear: vi.fn(),
      findOne: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      setActive: vi.fn(),
      softDelete: vi.fn(),
      undelete: vi.fn(),
      cloneYear: vi.fn(),
    };
    const deps = { ...makeDeps(), planRepo } as unknown as UpdateFeeConfigDeps;
    const result = await updateFeeConfig(
      { ...baseInput, patch: { currency_code: 'SEK' } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('99');
      }
    }
  });

  // ---- Step 3 (currency same as current) - silent drop --------------------

  it('drops currency_code silently when it matches current (no error, no diff)', async () => {
    // currency_code: 'THB' same as current → silently dropped
    // vat_rate also unchanged → no diff → idempotent no-op
    const deps = makeDeps();
    const result = await updateFeeConfig(
      { ...baseInput, patch: { currency_code: 'THB', vat_rate: 0.07 } },
      deps,
    );

    expect(result.ok).toBe(true);
    // No plan count check since currency not actually changing
    expect(deps.planRepo.countActiveForTenant).not.toHaveBeenCalled();
    // No DB write since diff is empty
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  // ---- Step 5: idempotent no-op -------------------------------------------

  it('returns ok(current) without writing when patch has no effective changes', async () => {
    const current = makeFeeConfig();
    const deps = makeDeps({ currentConfig: current });
    // vat_rate same as current (0.07), so diff is empty
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.07 } },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(current);
    }
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns ok(current) when registration_fee_minor_units unchanged', async () => {
    const current = makeFeeConfig({ registration_fee_minor_units: 100_000 });
    const deps = makeDeps({ currentConfig: current });
    const result = await updateFeeConfig(
      { ...baseInput, patch: { registration_fee_minor_units: 100_000 } },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(current);
    }
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
  });

  it('returns ok(current) when empty patch {} has no effective changes', async () => {
    const current = makeFeeConfig();
    const deps = makeDeps({ currentConfig: current });
    const result = await updateFeeConfig(
      { ...baseInput, patch: {} },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(current);
    }
    expect(deps.feeConfigRepo.update).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  // ---- Step 6: feeConfigRepo.update error paths ---------------------------

  it('returns server_error when feeConfigRepo.update throws', async () => {
    const deps = makeDeps({ updateResult: new Error('Update constraint violation') });
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('Update constraint violation');
      }
    }
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns server_error with string coercion when feeConfigRepo.update throws non-Error', async () => {
    const feeConfigRepo = {
      findByTenant: vi.fn(async () => makeFeeConfig()),
      update: vi.fn(async () => { throw { code: 'UNIQUE_VIOLATION' }; }),
      upsert: vi.fn(),
    };
    const deps = { ...makeDeps(), feeConfigRepo } as unknown as UpdateFeeConfigDeps;
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('[object Object]');
      }
    }
  });

  it('returns not_found when feeConfigRepo.update returns undefined', async () => {
    const deps = makeDeps({ updateResult: null });
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_found');
    }
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  // ---- Step 7: audit failure ----------------------------------------------

  it('returns audit_failed when audit.record returns persist_failed', async () => {
    const deps = makeDeps({ auditFail: true });
    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1 } },
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') {
        expect(result.error.message).toBe('audit write error');
      }
    }
  });

  it('returns audit_failed with joined issues when audit.record returns invalid_payload', async () => {
    const updated = makeFeeConfig({ vat_rate: 0.1 });
    const deps = makeDeps({ updateResult: updated });
    // Override audit to return invalid_payload
    const audit = {
      record: vi.fn(async () =>
        err({
          type: 'invalid_payload' as const,
          issues: ['diff: required', 'vat_rate: invalid'] as readonly string[],
        }),
      ),
    };
    const depsWithBadAudit = { ...deps, audit } as unknown as UpdateFeeConfigDeps;

    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1 } },
      depsWithBadAudit,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') {
        expect(result.error.message).toBe('diff: required; vat_rate: invalid');
      }
    }
  });

  // ---- Happy paths --------------------------------------------------------

  it('happy path: vat_rate change → ok + fee_config_updated audit with diff', async () => {
    const updated = makeFeeConfig({ vat_rate: 0.1, updated_by: 'actor-user-uuid' });
    const deps = makeDeps({ updateResult: updated });

    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1 } },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(updated);
      expect(result.value.vat_rate).toBe(0.1);
    }

    // Verify feeConfigRepo.update called with correct args
    expect(deps.feeConfigRepo.update).toHaveBeenCalledWith(
      tenant,
      { vat_rate: 0.1 },
      baseInput.actorUserId,
    );

    // Verify audit event
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [auditCtx, auditEvent] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditCtx).toEqual({
      tenant,
      actorUserId: baseInput.actorUserId,
      requestId: baseInput.requestId,
      sourceIp: baseInput.sourceIp,
    });
    expect(auditEvent.event_type).toBe('fee_config_updated');
    expect(auditEvent.payload.diff.vat_rate).toEqual({ before: 0.07, after: 0.1 });
    expect(auditEvent.payload.diff.registration_fee_minor_units).toBeUndefined();
    expect(auditEvent.payload.diff.currency_code).toBeUndefined();
  });

  it('happy path: registration_fee_minor_units change → ok + audit diff contains only changed field', async () => {
    const updated = makeFeeConfig({ registration_fee_minor_units: 200_000, updated_by: 'actor-user-uuid' });
    const deps = makeDeps({ updateResult: updated });

    const result = await updateFeeConfig(
      { ...baseInput, patch: { registration_fee_minor_units: 200_000 } },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registration_fee_minor_units).toBe(200_000);
    }

    const [, auditEvent] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditEvent.payload.diff.registration_fee_minor_units).toEqual({
      before: 100_000,
      after: 200_000,
    });
    expect(auditEvent.payload.diff.vat_rate).toBeUndefined();
  });

  it('happy path: multiple fields changed together → audit diff contains all changed fields', async () => {
    const updated = makeFeeConfig({
      vat_rate: 0.1,
      registration_fee_minor_units: 200_000,
      updated_by: 'actor-user-uuid',
    });
    const deps = makeDeps({ updateResult: updated });

    const result = await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1, registration_fee_minor_units: 200_000 } },
      deps,
    );

    expect(result.ok).toBe(true);

    const [, auditEvent] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditEvent.payload.diff.vat_rate).toEqual({ before: 0.07, after: 0.1 });
    expect(auditEvent.payload.diff.registration_fee_minor_units).toEqual({
      before: 100_000,
      after: 200_000,
    });

    // feeConfigRepo.update called with both fields
    expect(deps.feeConfigRepo.update).toHaveBeenCalledWith(
      tenant,
      { vat_rate: 0.1, registration_fee_minor_units: 200_000 },
      baseInput.actorUserId,
    );
  });

  it('happy path: currency change allowed when 0 plans → ok + diff includes currency_code', async () => {
    const updated = makeFeeConfig({ currency_code: 'SEK', updated_by: 'actor-user-uuid' });
    const deps = makeDeps({
      countActiveForTenantResult: 0,
      updateResult: updated,
    });

    const result = await updateFeeConfig(
      { ...baseInput, patch: { currency_code: 'SEK' } },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.currency_code).toBe('SEK');
    }

    // Guard was checked
    expect(deps.planRepo.countActiveForTenant).toHaveBeenCalledWith(tenant);

    // update called with currency_code in patch
    expect(deps.feeConfigRepo.update).toHaveBeenCalledWith(
      tenant,
      { currency_code: 'SEK' },
      baseInput.actorUserId,
    );

    // Audit diff includes currency change
    const [, auditEvent] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditEvent.payload.diff.currency_code).toEqual({ before: 'THB', after: 'SEK' });
  });

  it('happy path: currency + vat change together with 0 plans → combined diff in audit', async () => {
    const updated = makeFeeConfig({
      currency_code: 'EUR',
      vat_rate: 0.2,
      updated_by: 'actor-user-uuid',
    });
    const deps = makeDeps({
      countActiveForTenantResult: 0,
      updateResult: updated,
    });

    const result = await updateFeeConfig(
      { ...baseInput, patch: { currency_code: 'EUR', vat_rate: 0.2 } },
      deps,
    );

    expect(result.ok).toBe(true);

    const [, auditEvent] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditEvent.payload.diff.currency_code).toEqual({ before: 'THB', after: 'EUR' });
    expect(auditEvent.payload.diff.vat_rate).toEqual({ before: 0.07, after: 0.2 });
  });

  it('records audit with null sourceIp when sourceIp is null', async () => {
    const updated = makeFeeConfig({ vat_rate: 0.1 });
    const deps = makeDeps({ updateResult: updated });
    const inputNullIp: UpdateFeeConfigInput = {
      ...baseInput,
      patch: { vat_rate: 0.1 },
      sourceIp: null,
    };

    const result = await updateFeeConfig(inputNullIp, deps);

    expect(result.ok).toBe(true);
    const [auditCtx] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditCtx.sourceIp).toBeNull();
  });

  it('does NOT call planRepo.countActiveForTenant when patch has no currency_code', async () => {
    const deps = makeDeps({
      updateResult: makeFeeConfig({ vat_rate: 0.1 }),
    });
    await updateFeeConfig(
      { ...baseInput, patch: { vat_rate: 0.1 } },
      deps,
    );

    expect(deps.planRepo.countActiveForTenant).not.toHaveBeenCalled();
  });
});
