import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getFeeConfig,
  type GetFeeConfigDeps,
} from '@/modules/plans/application/get-fee-config';
import { asTenantContext } from '@/modules/tenants';

const tenant = asTenantContext('swecham');
const NOW = new Date('2026-04-17T10:00:00.000Z');

const BASE_CONFIG = {
  tenant_id: 'swecham' as never,
  vat_rate: 0.07,
  currency_code: 'THB' as const,
  updated_at: NOW,
  updated_by: 'seed',
};

function makeDeps(overrides: {
  result?: typeof BASE_CONFIG | null | Error;
} = {}): GetFeeConfigDeps {
  return {
    tenant,
    feeConfigRepo: {
      findByTenant: vi.fn(async () => {
        if ('result' in overrides) {
          const r = overrides.result;
          if (r instanceof Error) throw r;
          return r;
        }
        return BASE_CONFIG;
      }),
      update: vi.fn(),
      upsert: vi.fn(),
    },
  } as unknown as GetFeeConfigDeps;
}

describe('getFeeConfig use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server_error when repo throws', async () => {
    const deps = makeDeps({ result: new Error('DB timeout') });
    const result = await getFeeConfig(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') expect(result.error.message).toBe('DB timeout');
    }
  });

  it('returns server_error with string coercion for non-Error throws', async () => {
    const deps = makeDeps();
    (deps.feeConfigRepo.findByTenant as ReturnType<typeof vi.fn>).mockRejectedValueOnce('plain string');
    const result = await getFeeConfig(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns not_found when repo returns null', async () => {
    const deps = makeDeps({ result: null });
    const result = await getFeeConfig(deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns ok with the fee config on success', async () => {
    const deps = makeDeps({ result: BASE_CONFIG });
    const result = await getFeeConfig(deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.vat_rate).toBe(0.07);
      expect(result.value.currency_code).toBe('THB');
    }
  });
});
