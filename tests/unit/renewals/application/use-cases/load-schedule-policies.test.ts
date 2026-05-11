/**
 * F8 Phase 4 Wave I1a · T081 spec — `loadSchedulePolicies` use-case.
 *
 * Read-only listing — no audit emit, no state mutation. Test scope is
 * input validation + repo passthrough.
 */
import { describe, expect, it, vi } from 'vitest';
import { assertOk } from '../../_helpers/assert-result';
import { loadSchedulePolicies } from '@/modules/renewals/application/use-cases/load-schedule-policies';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { TenantRenewalSchedulePolicy } from '@/modules/renewals/domain/tenant-renewal-schedule-policy';

const TENANT_ID = 'tenantA';

function buildPolicy(
  overrides: Partial<TenantRenewalSchedulePolicy> = {},
): TenantRenewalSchedulePolicy {
  return {
    tenantId: TENANT_ID,
    tierBucket: 'regular' as const,
    steps: [
      {
        stepId: 't-30.email',
        offsetDays: -30,
        channel: 'email' as const,
        templateId: 'renewal.t-30.regular',
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

function fakeDeps(
  policies: ReadonlyArray<TenantRenewalSchedulePolicy>,
): RenewalsDeps {
  return {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    schedulePolicyRepo: {
      findByBucket: vi.fn(),
      listAllForTenant: vi.fn(async () => policies),
      upsertSteps: vi.fn(),
    } as unknown as RenewalsDeps['schedulePolicyRepo'],
  } as unknown as RenewalsDeps;
}

describe('loadSchedulePolicies', () => {
  it('returns the full list from repo for valid input', async () => {
    const a = buildPolicy({ tierBucket: 'thai_alumni' as const });
    const b = buildPolicy({ tierBucket: 'premium' as const });
    const result = await loadSchedulePolicies(fakeDeps([a, b]), {
      tenantId: TENANT_ID,
    });
    assertOk(result);
    expect(result.value.policies).toHaveLength(2);
    expect(result.value.policies[0]!.tierBucket).toBe('thai_alumni');
    expect(result.value.policies[1]!.tierBucket).toBe('premium');
  });

  it('returns empty list when tenant has zero seeded policies (RLS-hidden or fresh tenant)', async () => {
    const result = await loadSchedulePolicies(fakeDeps([]), {
      tenantId: TENANT_ID,
    });
    assertOk(result);
    expect(result.value.policies).toHaveLength(0);
  });

  it('rejects empty tenantId with invalid_input', async () => {
    const result = await loadSchedulePolicies(fakeDeps([]), {
      tenantId: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('passes the tenantId verbatim to listAllForTenant', async () => {
    const deps = fakeDeps([]);
    const spy = deps.schedulePolicyRepo.listAllForTenant as ReturnType<
      typeof vi.fn
    >;
    await loadSchedulePolicies(deps, { tenantId: TENANT_ID });
    expect(spy).toHaveBeenCalledWith(TENANT_ID);
  });
});
