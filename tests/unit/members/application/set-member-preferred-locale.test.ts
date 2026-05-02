/**
 * R4 verify-fix Types-#6 — unit tests for `setMemberPreferredLocale`.
 *
 * Covers:
 *  - updated path emits `member_preferred_locale_changed` audit
 *  - idempotent unchanged path (no UPDATE, no audit)
 *  - member_self_service actor role recorded in payload
 *  - not_found path (UPDATE affected=0, no audit)
 *  - repo error surfacing
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({}),
  ),
}));

import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';
import { setMemberPreferredLocale } from '@/modules/members/application/use-cases/set-member-preferred-locale';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');

function makeDeps(overrides: {
  current: 'en' | 'th' | 'sv' | null | { error: unknown };
  updateAffected?: number;
  updateError?: unknown;
}) {
  const memberRepo = {
    findPreferredLocaleInTx: vi.fn().mockResolvedValue(
      typeof overrides.current === 'object' && overrides.current !== null
        ? err((overrides.current as { error: unknown }).error)
        : ok(overrides.current),
    ),
    updatePreferredLocaleInTx: vi.fn().mockResolvedValue(
      overrides.updateError !== undefined
        ? err(overrides.updateError)
        : ok({ affected: overrides.updateAffected ?? 1 }),
    ),
  } as unknown as Parameters<typeof setMemberPreferredLocale>[0]['memberRepo'];
  const audit = {
    recordInTx: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof setMemberPreferredLocale>[0]['audit'];
  return { memberRepo, audit };
}

describe('setMemberPreferredLocale', () => {
  it('updated path: emits member_preferred_locale_changed audit', async () => {
    const { memberRepo, audit } = makeDeps({ current: null });
    const result = await setMemberPreferredLocale(
      { tenant, memberRepo, audit },
      {
        memberId,
        nextValue: 'th',
        actor: { kind: 'admin', userId: 'user-admin-1' },
        requestId: 'req-1',
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('updated');
    }
    expect(memberRepo.updatePreferredLocaleInTx).toHaveBeenCalledWith(
      {},
      memberId,
      'th',
    );
    expect(audit.recordInTx).toHaveBeenCalledTimes(1);
    const auditCall = (audit.recordInTx as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(auditCall.type).toBe('member_preferred_locale_changed');
    expect(auditCall.payload.previousValue).toBeNull();
    expect(auditCall.payload.nextValue).toBe('th');
    expect(auditCall.payload.actorRole).toBe('admin');
  });

  it('idempotent unchanged: no UPDATE, no audit', async () => {
    const { memberRepo, audit } = makeDeps({ current: 'th' });
    const result = await setMemberPreferredLocale(
      { tenant, memberRepo, audit },
      {
        memberId,
        nextValue: 'th',
        actor: { kind: 'admin', userId: 'user-admin-1' },
        requestId: null,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('unchanged');
    expect(memberRepo.updatePreferredLocaleInTx).not.toHaveBeenCalled();
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });

  it('member_self_service actor role recorded in audit payload', async () => {
    const { memberRepo, audit } = makeDeps({ current: 'en' });
    const result = await setMemberPreferredLocale(
      { tenant, memberRepo, audit },
      {
        memberId,
        nextValue: null,
        actor: { kind: 'member_self_service', userId: 'user-member-1' },
        requestId: null,
      },
    );

    expect(result.ok).toBe(true);
    const auditCall = (audit.recordInTx as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(auditCall.payload.actorRole).toBe('member_self_service');
    expect(auditCall.payload.previousValue).toBe('en');
    expect(auditCall.payload.nextValue).toBeNull();
  });

  it('not_found: UPDATE affected=0 → no audit', async () => {
    const { memberRepo, audit } = makeDeps({
      current: null,
      updateAffected: 0,
    });
    const result = await setMemberPreferredLocale(
      { tenant, memberRepo, audit },
      {
        memberId,
        nextValue: 'sv',
        actor: { kind: 'admin', userId: 'user-admin-1' },
        requestId: null,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('not_found');
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });

  it('repo error on findPreferredLocaleInTx surfaces as repo_error', async () => {
    const { memberRepo, audit } = makeDeps({
      current: { error: 'boom' },
    });
    const result = await setMemberPreferredLocale(
      { tenant, memberRepo, audit },
      {
        memberId,
        nextValue: 'th',
        actor: { kind: 'admin', userId: 'user-admin-1' },
        requestId: null,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('repo_error');
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });
});
