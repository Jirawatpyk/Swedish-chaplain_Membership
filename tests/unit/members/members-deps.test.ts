/**
 * Unit tests for the members-module composition factories.
 *
 * `buildMemberProbeDeps` is a pure object-literal factory but carries
 * a precise `Pick<MembersDeps, ...>` contract. A regression where a
 * maintainer accidentally drops `audit` (which drives the
 * `member_cross_tenant_probe` audit emit) would silently break
 * Constitution Principle I clause 4 — probe audit required on every
 * cross-tenant miss. Cheap guard to keep the factory honest.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMemberProbeDeps,
  buildMembersDeps,
} from '@/modules/members/members-deps';
import type { TenantContext } from '@/modules/tenants';

const tenant = { slug: 'test-swecham-00000000' } as unknown as TenantContext;

describe('buildMemberProbeDeps', () => {
  it('returns exactly the GetMemberDeps subset — tenant + memberRepo + contactRepo + audit', () => {
    const deps = buildMemberProbeDeps(tenant);
    expect(Object.keys(deps).sort()).toEqual([
      'audit',
      'contactRepo',
      'memberRepo',
      'tenant',
    ]);
  });

  it('reuses the same adapter instances as the full deps bag', () => {
    const full = buildMembersDeps(tenant);
    const probe = buildMemberProbeDeps(tenant);
    expect(probe.memberRepo).toBe(full.memberRepo);
    expect(probe.contactRepo).toBe(full.contactRepo);
    expect(probe.audit).toBe(full.audit);
  });

  it('passes through the tenant argument verbatim', () => {
    const deps = buildMemberProbeDeps(tenant);
    expect(deps.tenant).toBe(tenant);
  });
});
