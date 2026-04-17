import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  affectedMembersCount,
  type AffectedMembersCountInput,
  type AffectedMembersCountDeps,
} from '@/modules/members/application/use-cases/affected-members-count';
import { asTenantContext } from '@/modules/tenants';
import type { PlanId } from '@/modules/members/domain/member';

const tenant = asTenantContext('swecham');
const planId = 'plan-id-001' as PlanId;

const baseInput: AffectedMembersCountInput = {
  planId,
  planYear: 2026,
};

function makeDeps(overrides: {
  result?: { count: number } | Error;
} = {}): AffectedMembersCountDeps {
  return {
    tenant,
    plans: {
      countAffectedMembers: vi.fn(async () => {
        if (overrides.result instanceof Error) {
          return err({ code: 'repo.unexpected' as const });
        }
        if (overrides.result) {
          return ok(overrides.result);
        }
        return ok({ count: 0 });
      }),
    },
  } as unknown as AffectedMembersCountDeps;
}

describe('affectedMembersCount use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server_error when countAffectedMembers returns err', async () => {
    const deps = makeDeps({ result: new Error('unused') });
    const result = await affectedMembersCount(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toContain('affected-members');
      }
    }
  });

  it('returns ok with count on success', async () => {
    const deps = makeDeps({ result: { count: 7 } });
    const result = await affectedMembersCount(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.count).toBe(7);
  });

  it('passes tenant, planId, planYear to repo', async () => {
    const deps = makeDeps();
    await affectedMembersCount(baseInput, deps);
    expect(deps.plans.countAffectedMembers).toHaveBeenCalledWith(tenant, planId, 2026);
  });
});
