/**
 * T139 — Contract test: PATCH /api/fee-config currency-code immutability
 * (critique R1, plans-api.md § 13).
 *
 * When an admin PATCHes fee-config with a `currency_code` value different
 * from the current one AND non-deleted plans exist, the API MUST reject
 * with `422 currency_code_immutable_in_f2` and return `details`:
 *
 *   - current_currency_code
 *   - attempted_currency_code
 *   - non_deleted_plan_count
 *   - remediation
 *
 * The remediation copy is frozen at the contract layer (plans-api.md § 13):
 *   "Delete or soft-delete all plans for this tenant, then change currency,
 *    then rebuild plans. Proper currency migration with FX-rate-aware
 *    revaluation is an F10 concern."
 *
 * This contract test mocks the use case, so it covers only the route
 * wiring + HTTP shape. The *guard* (plan-count > 0 → 422) is covered
 * end-to-end against live Neon in tests/integration/plans/fee-config-currency-immutable.test.ts (T141).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const updateFeeConfigMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
vi.mock('@/modules/plans', async () => {
  const actual = await vi.importActual<typeof import('@/modules/plans')>(
    '@/modules/plans',
  );
  return {
    ...actual,
    updateFeeConfig: (...args: unknown[]) => updateFeeConfigMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => undefined),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'deterministic-hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'admin@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-fee-imm-1',
};

const REMEDIATION_COPY =
  'Delete or soft-delete all plans for this tenant, then change currency, then rebuild plans. Proper currency migration with FX-rate-aware revaluation is an F10 concern.';

describe('contract: PATCH /api/fee-config currency immutability (T139, critique R1)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('422 currency_code_immutable_in_f2 — includes full details', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updateFeeConfigMock.mockResolvedValueOnce(
      err({
        type: 'currency_code_immutable_in_f2',
        current_currency_code: 'THB',
        attempted_currency_code: 'JPY',
        non_deleted_plan_count: 9,
      }),
    );

    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(
      new NextRequest('http://localhost/api/fee-config', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-currency-change-1',
        },
        body: JSON.stringify({ currency_code: 'JPY' }),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error?.code).toBe('currency_code_immutable_in_f2');
    expect(body.error?.details?.current_currency_code).toBe('THB');
    expect(body.error?.details?.attempted_currency_code).toBe('JPY');
    expect(body.error?.details?.non_deleted_plan_count).toBe(9);
    expect(body.error?.details?.remediation).toBe(REMEDIATION_COPY);
  });

  it('200 no-op when currency_code matches current (silent ignore)', async () => {
    // If the client sends currency_code equal to the current one, the
    // use case treats it as no change and returns ok() without running
    // the plan-count guard. Contract-level expectation only.
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updateFeeConfigMock.mockResolvedValueOnce({
      ok: true as const,
      value: {
        tenant_id: 'test-swecham',
        currency_code: 'THB' as const,
        vat_rate: 0.07,
        registration_fee_minor_units: 100_000,
        updated_at: new Date('2026-04-11T10:00:00Z'),
        updated_by: 'admin-1',
      },
    });

    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(
      new NextRequest('http://localhost/api/fee-config', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'idem-same-currency',
        },
        body: JSON.stringify({ currency_code: 'THB' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currency_code).toBe('THB');
  });
});
