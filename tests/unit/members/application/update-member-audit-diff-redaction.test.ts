/**
 * 059 / GUARD 3 (member-tax-correctness) — the `member_updated` audit diff
 * must NEVER carry the raw `taxId` value.
 *
 * Background: a foreign natural person has no Thai TIN, so the maintainer
 * lets `members.tax_id` hold a passport / work-permit number instead. Today
 * `buildDiff()` in update-member.ts records `{ old: currentVal, new:
 * patch[key] }` verbatim for EVERY changed field, including `taxId` — so a
 * passport number lands in `audit_log.payload.diff.taxId` (5-year retention).
 *
 * `audit_log` is append-only: nothing in `src/` ever issues an `UPDATE`
 * against it (verified via grep — no `.update(auditLog...)` call site
 * exists anywhere in the codebase). So a raw passport number written into
 * the diff SURVIVES a GDPR Art. 17 erasure: `eraseMember` NULLs
 * `members.tax_id`, but cannot reach the audit row. The identifier persists
 * for years after the data subject exercised their right to erasure.
 *
 * The fix: record that `taxId` CHANGED (fields_changed still names it, so
 * accountability is preserved — WHO changed WHAT field WHEN), but never
 * record the VALUE it changed to/from.
 *
 * Mirrors update-member-vat-registrant.test.ts's stub pattern: `runInTenant`
 * invokes its callback directly with a dummy tx, and `memberRepo` /
 * `audit` are hand-rolled stubs — no live DB. Assertions read the ACTUAL
 * payload object passed to `audit.recordInTx`, not just call counts.
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

import { updateMember } from '@/modules/members/application/use-cases/update-member';
import type { UpdateMemberDeps } from '@/modules/members/application/use-cases/update-member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';
import type { TaxId } from '@/modules/members/domain/value-objects/tax-id';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('33333333-3333-4333-8333-333333333333');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-audit-diff-redaction' };

// A realistic passport number — the exact kind of value that must NEVER
// reach the audit payload. Country is deliberately non-TH (SE) so the
// tax-id validator's free-form "1..50 chars, no checksum" branch accepts
// it (see tax-id.ts) — this is exactly the foreign-member/passport shape
// the maintainer decided to allow into members.tax_id.
const PASSPORT_OLD = 'SE1234567' as unknown as TaxId;
const PASSPORT_NEW = 'AB9876543';

function baseMember(overrides: { taxId?: TaxId | null }) {
  return {
    tenantId: tenant.slug as never,
    memberId,
    companyName: 'Acme AB',
    legalEntityType: null,
    country: 'SE' as never,
    taxId: overrides.taxId ?? null,
    isVatRegistered: false,
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
  const recordInTx = vi.fn().mockResolvedValue(ok(undefined));
  const memberRepo = {
    findByIdInTx: vi.fn().mockResolvedValue(ok(current)),
    updateFieldsInTx,
  } as unknown as UpdateMemberDeps['memberRepo'];
  return {
    deps: {
      tenant,
      memberRepo,
      audit: { record: vi.fn(), recordInTx },
      clock: { now: () => new Date('2026-07-14') },
    } as unknown as UpdateMemberDeps,
    recordInTx,
  };
}

describe('updateMember — member_updated audit diff never carries a raw taxId value (GUARD 3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setting taxId (null → passport number): fields_changed names taxId, diff carries NO raw value', async () => {
    const current = baseMember({ taxId: null });
    const { deps, recordInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { tax_id: PASSPORT_NEW },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(recordInTx).toHaveBeenCalledOnce();

    const event = recordInTx.mock.calls[0]?.[2] as {
      payload: { fields_changed: string[]; diff: Record<string, unknown> };
    };
    // Accountability is preserved — the auditor can see taxId changed.
    expect(event.payload.fields_changed).toContain('taxId');
    // But the raw passport number must NEVER appear anywhere in the payload.
    const serialised = JSON.stringify(event.payload);
    expect(serialised).not.toContain(PASSPORT_NEW);
    // The diff entry for taxId must not equal the raw value shape either.
    expect(event.payload.diff.taxId).not.toEqual({
      old: null,
      new: PASSPORT_NEW,
    });
  });

  it('clearing taxId (passport number → null): diff carries NO raw old value', async () => {
    const current = baseMember({ taxId: PASSPORT_OLD });
    const { deps, recordInTx } = depsFor(current);

    const result = await updateMember(memberId, { tax_id: null }, meta, deps);

    expect(result.ok).toBe(true);
    expect(recordInTx).toHaveBeenCalledOnce();

    const event = recordInTx.mock.calls[0]?.[2] as {
      payload: { fields_changed: string[]; diff: Record<string, unknown> };
    };
    expect(event.payload.fields_changed).toContain('taxId');
    const serialised = JSON.stringify(event.payload);
    expect(serialised).not.toContain(PASSPORT_OLD as unknown as string);
    expect(event.payload.diff.taxId).not.toEqual({
      old: PASSPORT_OLD,
      new: null,
    });
  });

  it('an unrelated field change alongside a taxId change: the OTHER field diff is untouched', async () => {
    // Guards against an over-broad fix that accidentally strips every
    // field's diff, not just taxId's.
    const current = baseMember({ taxId: null });
    const { deps, recordInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { company_name: 'Renamed AB', tax_id: PASSPORT_NEW },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    const event = recordInTx.mock.calls[0]?.[2] as {
      payload: { fields_changed: string[]; diff: Record<string, { old: unknown; new: unknown }> };
    };
    expect(event.payload.fields_changed).toEqual(
      expect.arrayContaining(['companyName', 'taxId']),
    );
    expect(event.payload.diff.companyName).toEqual({
      old: 'Acme AB',
      new: 'Renamed AB',
    });
    const serialised = JSON.stringify(event.payload);
    expect(serialised).not.toContain(PASSPORT_NEW);
  });
});
