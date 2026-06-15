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
  buildEraseMemberDeps,
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

describe('buildEraseMemberDeps', () => {
  it('returns exactly the EraseMemberDeps nine fields — the archive cascade subset', () => {
    const deps = buildEraseMemberDeps(tenant);
    expect(Object.keys(deps).sort()).toEqual([
      'audit',
      'broadcastsCascade',
      'clock',
      'contactRepo',
      'invitations',
      'memberRepo',
      'renewalsCascade',
      'sessions',
      'tenant',
    ]);
  });

  it('reuses the same adapter instances as the full deps bag', () => {
    const full = buildMembersDeps(tenant);
    const erase = buildEraseMemberDeps(tenant);
    // Compliance-critical wiring: a type-compatible but WRONG adapter for
    // `audit` would silently break the GDPR Art.17 / PDPA §33
    // member_erasure_requested / member_erased DPO audit, and a wrong
    // cascade adapter would skip the F7/F8 in-flight cancels. Reference
    // equality is what catches that — TypeScript can't.
    expect(erase.audit).toBe(full.audit);
    expect(erase.broadcastsCascade).toBe(full.broadcastsCascade);
    expect(erase.renewalsCascade).toBe(full.renewalsCascade);
    expect(erase.sessions).toBe(full.sessions);
    expect(erase.memberRepo).toBe(full.memberRepo);
    expect(erase.contactRepo).toBe(full.contactRepo);
    expect(erase.invitations).toBe(full.invitations);
    expect(erase.clock).toBe(full.clock);
  });

  it('passes through the tenant argument verbatim', () => {
    const deps = buildEraseMemberDeps(tenant);
    expect(deps.tenant).toBe(tenant);
  });
});
