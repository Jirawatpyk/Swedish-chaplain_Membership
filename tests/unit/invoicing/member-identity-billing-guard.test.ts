/**
 * member-billing-address (0284) / tax-review LOW-1 — the billing-arm
 * fail-loud guard in memberIdentityAdapter.getForIssue.
 *
 * `members_billing_address_group_ck` guarantees billing_country IS NOT NULL
 * whenever billing_address_line1 is set — so the corrupt state can NEVER be
 * seeded through the live DB, and the integration suite
 * (tests/integration/invoicing/member-identity-address.test.ts) can only pin
 * the happy paths. This suite stubs the tx to feed the adapter a corrupt row
 * directly and proves the guard (a) actually fires (issue-blocking throw —
 * same posture as the asMemberNumber corrupt-identity throw) rather than
 * silently printing a MIXED address (billing street under the company's
 * country) on a §86/4 tax document, and (b) leaves both healthy arms intact.
 */
import { describe, expect, it } from 'vitest';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    member_id: '11111111-1111-4111-8111-111111111111',
    company_name: 'Guard Co',
    tax_id: null,
    country: 'TH',
    status: 'active',
    address_line1: '99/1 Operating Rd',
    address_line2: null,
    sub_district: null,
    city: 'Bangkok',
    province: null,
    postal_code: '10110',
    billing_address_line1: null,
    billing_address_line2: null,
    billing_sub_district: null,
    billing_city: null,
    billing_province: null,
    billing_postal_code: null,
    billing_country: null,
    archived_at: null,
    erased_at: null,
    registration_date: new Date('2026-01-01'),
    registration_fee_paid: true,
    member_number: 42,
    member_number_prefix: 'SCCM',
    member_type_scope: 'company' as const,
    is_vat_registered: false,
    is_head_office: true,
    branch_code: null,
    ...overrides,
  };
}

/**
 * Minimal tx double: `execute` returns the members row; the drizzle
 * `select().from().where().limit(1)` primary-contact chain resolves empty
 * (the adapter tolerates a missing primary contact — '' name/email).
 */
function stubTx(row: Record<string, unknown>): unknown {
  return {
    execute: async () => [row],
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  };
}

describe('memberIdentityAdapter — billing-arm fail-loud guard (LOW-1)', () => {
  it('THROWS (aborting issuance) on a corrupt group: billing line1 set, billing_country NULL', async () => {
    const tx = stubTx(
      baseRow({
        billing_address_line1: '55 Registered Tax Rd',
        billing_city: 'Bangkok',
        billing_postal_code: '10500',
        billing_country: null, // corrupt — DB CHECK makes this unreachable live
      }),
    );
    await expect(
      memberIdentityAdapter.getForIssue(tx as never, 'test-tenant', 'm-1'),
    ).rejects.toThrow(/billing_address_line1 is set but billing_country is NULL/);
  });

  it('healthy billing group still composes from the BILLING columns (guard does not over-fire)', async () => {
    const tx = stubTx(
      baseRow({
        billing_address_line1: '55 Registered Tax Rd',
        billing_city: 'Bangkok',
        billing_postal_code: '10500',
        billing_country: 'TH',
      }),
    );
    const view = await memberIdentityAdapter.getForIssue(
      tx as never,
      'test-tenant',
      'm-2',
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.address).toContain('55 Registered Tax Rd');
    expect(view!.snapshot.address).not.toContain('99/1 Operating Rd');
  });

  it('no billing group → company arm unaffected (guard not armed)', async () => {
    const view = await memberIdentityAdapter.getForIssue(
      stubTx(baseRow()) as never,
      'test-tenant',
      'm-3',
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.address).toContain('99/1 Operating Rd');
  });
});
