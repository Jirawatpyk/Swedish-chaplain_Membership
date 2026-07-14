/**
 * 059 / PR-A Task 4 — the registrant ⇒ TIN invariant, enforced in the
 * use-case BODY (not updateMemberSchema's superRefine).
 *
 * updateMemberSchema validates a PARTIAL patch: `is_vat_registered` and
 * `tax_id` may each be absent from any given request. A patch that only
 * flips `is_vat_registered: true` looks fine in isolation (tax_id isn't part
 * of THIS request); a patch that only clears `tax_id` looks fine too — but
 * either can leave the member registrant-with-no-TIN. Only the RESULTING
 * member state (`current` merged with the patch) can tell, so the rule lives
 * in update-member.ts's use-case body, where `current` is read before
 * patching. See update-member.ts and .superpowers/sdd/task-4-brief.md.
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
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-vat-registrant' };

// A dummy branded TaxId — the invariant only checks null-ness, never the
// underlying checksum, so any non-null value stands in for "member already
// has a TIN on file".
const dummyTaxId = '0105556012341' as unknown as TaxId;

function baseMember(overrides: {
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

describe('updateMemberSchema — the registrant ⇒ TIN rule is deliberately ABSENT here', () => {
  // Regression guard for the trap called out in task-4-brief.md: if a future
  // change "helpfully" moves the invariant into this schema, a legitimate
  // partial patch (e.g. `{ is_vat_registered: true }` on a member that
  // already has a tax_id on file) would start failing at the SCHEMA layer,
  // even though the resulting state is perfectly valid.
  it('a patch that only sets is_vat_registered:true parses fine at the schema level', () => {
    const result = updateMemberSchema.safeParse({ is_vat_registered: true });
    expect(result.success).toBe(true);
  });

  it('a patch that only clears tax_id parses fine at the schema level', () => {
    const result = updateMemberSchema.safeParse({ tax_id: null });
    expect(result.success).toBe(true);
  });
});

describe('updateMember — registrant ⇒ TIN invariant, checked against the RESULTING state (059 / PR-A Task 4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. sets is_vat_registered:true, member ALREADY has a tax_id ⇒ allowed', async () => {
    const current = baseMember({ isVatRegistered: false, taxId: dummyTaxId });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_vat_registered: true },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('2. sets is_vat_registered:true, member has NO tax_id ⇒ rejected', async () => {
    const current = baseMember({ isVatRegistered: false, taxId: null });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_vat_registered: true },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('vat_registrant_requires_tax_id');
    }
    // The write must NEVER be attempted once the resulting state is invalid.
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('3. clears tax_id, member is ALREADY a registrant ⇒ rejected (the innocent-looking one)', async () => {
    const current = baseMember({ isVatRegistered: true, taxId: dummyTaxId });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(memberId, { tax_id: null }, meta, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('vat_registrant_requires_tax_id');
    }
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('4. sets is_vat_registered:true AND a tax_id in the SAME request ⇒ allowed', async () => {
    const current = baseMember({ isVatRegistered: false, taxId: null });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_vat_registered: true, tax_id: '0105556012341' },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('an unrelated-field-only patch on an already-violating member is NOT blocked', async () => {
    // Neither is_vat_registered nor tax_id is present in THIS patch — the
    // check is gated on the patch actually touching one of the two fields
    // (mirrors the is_head_office/branch_code superRefine's own "fires only
    // when present" posture), so an edit to an unrelated field must never be
    // blocked by a member that is (for whatever legacy reason) already in a
    // registrant-with-no-TIN state.
    const current = baseMember({ isVatRegistered: true, taxId: null });
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

  it('clearing tax_id while ALSO setting is_vat_registered:false in the same request ⇒ allowed', async () => {
    // Both fields touched, but the resulting state is a non-registrant with
    // no TIN — a legal combination.
    const current = baseMember({ isVatRegistered: true, taxId: dummyTaxId });
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { is_vat_registered: false, tax_id: null },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });
});
