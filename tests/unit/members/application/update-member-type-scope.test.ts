/**
 * 127 (#645 review) — editing `legal_entity_type` is checked against the
 * member's current plan `memberTypeScope`, like createMember and changePlan.
 *
 * Before 127 an admin could turn a member on a company-only plan into an
 * `individual` with no check, so the state the plan-change rule refuses
 * could be reached by an edit. The maintainer chose: block, with an override
 * reason (recorded on the audit row).
 *
 * "Changes" means the patch value differs from the LOCKED row — the edit
 * form echoes the field back on every save, so an already-mismatched member
 * must still be editable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

import { updateMember, type UpdateMemberDeps } from '@/modules/members/application/use-cases/update-member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('44444444-4444-4444-8444-444444444444');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-127-scope' };

function member(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: tenant.slug,
    memberId,
    companyName: 'Acme Co',
    legalEntityType: 'limited_company',
    country: 'TH',
    taxId: null,
    isVatRegistered: false,
    website: null,
    planId: asPlanId('corporate-large'),
    planYear: 2026,
    status: 'active',
    archivedAt: null,
    ...overrides,
  };
}

function plan(scope: 'company' | 'individual' | 'both') {
  return {
    tenantId: tenant.slug,
    planId: asPlanId('corporate-large'),
    planYear: 2026,
    planNameEn: 'Corporate Large',
    planCategory: 'corporate',
    memberTypeScope: scope,
    minTurnoverThb: null,
    maxTurnoverThb: null,
    maxDurationYears: null,
    maxMemberAge: null,
    includesCorporatePlanId: null,
    isSoftDeleted: false,
  };
}

function depsFor(opts: { current?: ReturnType<typeof member>; locked?: ReturnType<typeof member>; scope?: 'company' | 'individual' | 'both' }) {
  const current = opts.current ?? member();
  const updateFieldsInTx = vi.fn((_tx: unknown, _id: unknown, patch: object) =>
    Promise.resolve(ok({ ...current, ...patch })),
  );
  const recordInTx = vi.fn().mockResolvedValue(ok(undefined));
  const deps = {
    tenant,
    memberRepo: {
      findById: vi.fn().mockResolvedValue(ok(current)),
      findByIdInTx: vi.fn().mockResolvedValue(ok(opts.locked ?? current)),
      updateFieldsInTx,
    },
    plans: { getPlan: vi.fn().mockResolvedValue(ok(plan(opts.scope ?? 'company'))) },
    audit: { record: vi.fn(), recordInTx },
    clock: { now: () => new Date('2026-10-25') },
  };
  return deps as unknown as UpdateMemberDeps & typeof deps;
}

describe('updateMember — legal entity type vs plan member-type scope (127)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses turning a member on a company-only plan into an individual', async () => {
    const deps = depsFor({});
    const r = await updateMember(memberId, { legal_entity_type: 'individual' }, meta, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('member_type_out_of_scope');
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('accepts it with an override reason, recorded on the audit row', async () => {
    const deps = depsFor({});
    const r = await updateMember(
      memberId,
      {
        legal_entity_type: 'individual',
        override_reason_code: 'board_approved',
        override_reason_note: 'Sole trader, board agreed',
      },
      meta,
      deps,
    );
    expect(r.ok).toBe(true);
    const event = deps.audit.recordInTx.mock.calls[0]?.[2] as { payload: Record<string, unknown> };
    expect(event.payload.override_reason_code).toBe('board_approved');
  });

  it('lets an already-mismatched member save other fields when the type is echoed back unchanged', async () => {
    const mismatched = member({ legalEntityType: 'individual' });
    const deps = depsFor({ current: mismatched });
    const r = await updateMember(
      memberId,
      { legal_entity_type: 'individual', website: 'https://acme.example' },
      meta,
      deps,
    );
    expect(r.ok).toBe(true);
  });

  it('skips the plan lookup when the echoed type equals the stored one (127 review)', async () => {
    const deps = depsFor({});
    const r = await updateMember(
      memberId,
      { legal_entity_type: 'limited_company', company_name: 'Acme Co Ltd' },
      meta,
      deps,
    );
    expect(r.ok).toBe(true);
    expect(deps.plans.getPlan).not.toHaveBeenCalled();
  });

  it('passes a change that fits the plan scope, and any type on a "both" plan', async () => {
    expect((await updateMember(memberId, { legal_entity_type: 'public_company' }, meta, depsFor({}))).ok).toBe(true);
    expect(
      (await updateMember(memberId, { legal_entity_type: 'individual' }, meta, depsFor({ scope: 'both' }))).ok,
    ).toBe(true);
  });

  it('asks for a retry when the plan changed between the pre-read and the lock', async () => {
    const deps = depsFor({ locked: member({ planId: asPlanId('partnership-gold') }) });
    const r = await updateMember(memberId, { legal_entity_type: 'individual' }, meta, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('server_error');
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });
});
