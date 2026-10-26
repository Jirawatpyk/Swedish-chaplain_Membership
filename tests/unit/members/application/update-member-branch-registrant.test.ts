/**
 * 059 / PR-A Task 5 — the branch ⇒ VAT-registrant invariant, enforced in the
 * use-case BODY (not updateMemberSchema's superRefine).
 *
 * Mirrors update-member-vat-registrant.test.ts's (Task 4) reasoning exactly:
 * updateMemberSchema validates a PARTIAL patch, so `is_head_office`,
 * `branch_code`, and `is_vat_registered` may each be absent from any given
 * request. A patch that only flips `is_vat_registered: false` looks fine in
 * isolation (the branch fields aren't part of THIS request) — but if the
 * member is ALREADY a branch, the resulting row is a non-registrant branch,
 * which the tightened DB CHECK `members_branch_pairing_ck` (migration 0248)
 * now rejects. Only the RESULTING member state (`current` merged with the
 * patch) can tell, so the rule lives in update-member.ts's use-case body,
 * where `current` is read before patching. See update-member.ts and
 * .superpowers/sdd/task-5-brief.md.
 *
 * Mirrors m1-in-tx-not-found.test.ts's stub pattern: `runInTenant` invokes
 * its callback directly with a dummy tx, and `memberRepo` is a hand-rolled
 * stub — no live DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// runInTenant stub — invoke the callback with a dummy tx, re-throw what it throws.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { updateMember, updateMemberSchema } from '@/modules/members/application/use-cases/update-member';
import type { UpdateMemberDeps } from '@/modules/members/application/use-cases/update-member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';
import type { TaxId } from '@/modules/members/domain/value-objects/tax-id';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('22222222-2222-4222-8222-222222222222');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-branch-registrant' };

// A dummy branded TaxId — this suite's invariant only checks is_head_office /
// is_vat_registered, never the TIN itself. A non-null value here just keeps
// the Task 4 registrant⇒TIN check (also live in the use-case body) out of
// the way of tests that flip is_vat_registered:true.
const dummyTaxId = '0105556012341' as unknown as TaxId;

function baseMember(overrides: {
  isHeadOffice?: boolean;
  branchCode?: string | null;
  isVatRegistered?: boolean;
  taxId?: TaxId | null;
}) {
  return {
    tenantId: tenant.slug as never,
    memberId,
    companyName: 'Acme Ltd',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: overrides.taxId ?? null,
    isHeadOffice: overrides.isHeadOffice ?? true,
    branchCode: overrides.branchCode ?? null,
    isVatRegistered: overrides.isVatRegistered ?? false,
    website: null,
    description: null,
    foundedYear: 2020,
    turnoverThb: null,
    registeredCapitalThb: null,
    planId: asPlanId('plan-1'),
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: true,
    lastActivityAt: null,
    notes: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    province: null,
    postalCode: null,
    subDistrict: null,
    status: 'active' as const,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function depsFor(current: ReturnType<typeof baseMember>) {
  const updateFieldsInTx = vi
    .fn()
    .mockImplementation((_tx: unknown, _id: unknown, patch: object) =>
      Promise.resolve(ok({ ...current, ...patch })),
    );
  const memberRepo = {
    findByIdInTx: vi.fn().mockResolvedValue(ok(current)),
    updateFieldsInTx,
  } as unknown as UpdateMemberDeps['memberRepo'];
  return {
    deps: {
      tenant,
      memberRepo,
      audit: {
        record: vi.fn(),
        recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
      },
      clock: { now: () => new Date('2026-07-14') },
    } as unknown as UpdateMemberDeps,
    updateFieldsInTx,
  };
}

describe('updateMemberSchema — the branch ⇒ VAT-registrant rule is deliberately ABSENT here', () => {
  // Regression guard mirroring update-member-vat-registrant.test.ts: if a
  // future change "helpfully" moves the invariant into this schema, a
  // legitimate partial patch (e.g. `{ is_vat_registered: false }` on a
  // member that is already a head office) would start failing at the SCHEMA
  // layer, even though the resulting state is perfectly valid.
  it('a patch that only sets is_vat_registered:false parses fine at the schema level', () => {
    const result = updateMemberSchema.safeParse({ is_vat_registered: false });
    expect(result.success).toBe(true);
  });

  it('a patch that only sets is_head_office:true parses fine at the schema level', () => {
    const result = updateMemberSchema.safeParse({ is_head_office: true });
    expect(result.success).toBe(true);
  });
});

describe('updateMember — branch ⇒ VAT-registrant invariant, checked against the RESULTING state (059 / PR-A Task 5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. converts head office to a branch WITH is_vat_registered:true in the SAME request ⇒ allowed', async () => {
    // Already carries a tax_id on file so this doesn't ALSO trip the Task 4
    // registrant⇒TIN check (out of scope for this suite).
    const current = baseMember({
      isHeadOffice: true,
      isVatRegistered: false,
      taxId: dummyTaxId,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_head_office: false, branch_code: '00001', is_vat_registered: true },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('2. converts head office to a branch WITHOUT touching is_vat_registered, member is NOT a registrant ⇒ rejected', async () => {
    const current = baseMember({ isHeadOffice: true, isVatRegistered: false });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_head_office: false, branch_code: '00001' },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('branch_requires_vat_registrant');
    }
    // The write must NEVER be attempted once the resulting state is invalid.
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('3. clears is_vat_registered on a member ALREADY a branch ⇒ rejected (the innocent-looking one)', async () => {
    const current = baseMember({
      isHeadOffice: false,
      branchCode: '00001',
      isVatRegistered: true,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_vat_registered: false },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('branch_requires_vat_registrant');
    }
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('4. converts a branch back to a head office WITHOUT touching is_vat_registered ⇒ allowed', async () => {
    // resultingIsHeadOffice becomes true, so the branch leg never applies —
    // regardless of what is_vat_registered resolves to.
    const current = baseMember({
      isHeadOffice: false,
      branchCode: '00001',
      isVatRegistered: true,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_head_office: true, branch_code: null },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('an unrelated-field-only patch on an already-a-branch member is NOT blocked', async () => {
    // None of is_head_office / branch_code / is_vat_registered is present in
    // THIS patch — the check is gated on the patch actually touching one of
    // the three fields (mirrors the registrant ⇒ TIN check's own "fires only
    // when present" posture), so an edit to an unrelated field must never be
    // blocked by a member already in a (legacy) violating state.
    const current = baseMember({
      isHeadOffice: false,
      branchCode: '00001',
      isVatRegistered: false,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { company_name: 'Renamed Co' },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('5. sets is_vat_registered:false, member is ALREADY a head office ⇒ allowed', async () => {
    const current = baseMember({ isHeadOffice: true, isVatRegistered: true });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_vat_registered: false },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });
});

describe('updateMember — branch_code-ONLY patches, pre-existing since 0232/0236, surfaced by 0248 (Task 5 gate widened to fire on branch_code too)', () => {
  // Prior to this fix, the Task 5 gate above tested ONLY
  // `patch.isHeadOffice !== undefined || patch.isVatRegistered !== undefined`
  // — a patch touching ONLY `branch_code` sailed past it AND past
  // updateMemberSchema's superRefine (which fires only when `is_head_office`
  // is present), straight through to `updateFieldsInTx`. Against a real DB
  // that violates `members_branch_pairing_ck` (migration 0248) with a raw
  // constraint-violation 500 — see .superpowers/sdd/task-5-fix-report.md.
  beforeEach(() => vi.clearAllMocks());

  it('6. `{ branch_code }` ALONE on a head-office member is rejected with a typed error, NOT allowed through to the repo', async () => {
    const current = baseMember({
      isHeadOffice: true,
      branchCode: null,
      isVatRegistered: false,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { branch_code: '00001' },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Must be a typed domain-validation error, never the catch-all
      // `server_error` a raw Postgres CHECK violation would otherwise
      // produce (see drizzle-member-repo.ts's updateFieldsInTx, which has
      // no CHECK-violation classifier).
      expect(result.error.type).not.toBe('server_error');
      expect(result.error.type).toBe('head_office_branch_code_mismatch');
    }
    // The write must NEVER be attempted once the resulting state is invalid.
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('7. `{ branch_code: null }` ALONE on a branch member is rejected (would strand a branch with no code)', async () => {
    const current = baseMember({
      isHeadOffice: false,
      branchCode: '00001',
      isVatRegistered: true,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { branch_code: null },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).not.toBe('server_error');
      expect(result.error.type).toBe('head_office_branch_code_mismatch');
    }
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('a legitimate `{ is_head_office: false, branch_code, is_vat_registered: true }` patch still succeeds (no regression)', async () => {
    const current = baseMember({
      isHeadOffice: true,
      branchCode: null,
      isVatRegistered: false,
      taxId: dummyTaxId,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_head_office: false, branch_code: '00001', is_vat_registered: true },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('an unrelated-field-only patch on a member already carrying a valid branch is NOT blocked', async () => {
    const current = baseMember({
      isHeadOffice: false,
      branchCode: '00001',
      isVatRegistered: true,
    });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { company_name: 'Renamed Co' },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });
});
