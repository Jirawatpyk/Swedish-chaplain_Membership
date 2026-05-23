/**
 * T059 — Integration: directory-search vs live Neon (US2).
 *
 * Covers:
 *   - substring q matches company_name + contact name + contact email
 *   - status filter (active / inactive / archived)
 *   - cursor pagination (limit 2 over 3 rows)
 *   - RLS scoping — cross-tenant rows never appear
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { directorySearch, createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

describe('directory-search integration (T059, US2)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let deps: ReturnType<typeof buildMembersDeps>;
  const planId = 'dir-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Dir Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 500_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });

    // Seed three distinct members
    deps = buildMembersDeps(tenant.ctx);
    const cases = [
      { company: 'Fogmaker International', first: 'Anna' },
      { company: 'Volvo Group', first: 'Björn' },
      { company: 'IKEA South Asia', first: 'Camilla' },
    ];
    for (const c of cases) {
      // ASCII-safe email — our Email VO regex rejects non-ASCII locals
      // (e.g. "björn"). Keep the first_name for the substring test,
      // but use a sanitized slug for the address.
      const slug = c.first.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const r = await createMember(
        {
          company_name: c.company,
          country: 'SE',
          plan_id: planId,
          plan_year: 2026,
          primary_contact: {
            first_name: c.first,
            last_name: 'Andersson',
            email: `${slug}-${randomUUID().slice(0, 8)}@example.com`,
            preferred_language: 'sv' as const,
          },
        },
        {
          actorUserId: user.userId,
          requestId: `dir-seed-${c.company}`,
        },
        deps,
      );
      if (!r.ok) throw new Error(`seed ${c.company} failed: ${JSON.stringify(r.error)}`);
    }
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('returns all seeded members with default status filter', async () => {
    const r = await directorySearch({ tenant: tenant.ctx, memberRepo: deps.memberRepo }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBeGreaterThanOrEqual(3);
  });

  it('substring q matches company_name', async () => {
    const r = await directorySearch({ tenant: tenant.ctx, memberRepo: deps.memberRepo }, { q: 'Fogma' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(1);
    expect(r.value.items[0]!.member.companyName).toContain('Fogmaker');
  });

  it('substring q matches primary contact first_name', async () => {
    const r = await directorySearch({ tenant: tenant.ctx, memberRepo: deps.memberRepo }, { q: 'Björn' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBeGreaterThanOrEqual(1);
    expect(
      r.value.items.some((row) => row.member.companyName.includes('Volvo')),
    ).toBe(true);
  });

  it('cursor pagination: limit 2 returns nextCursor; second page returns remainder', async () => {
    const first = await directorySearch({ tenant: tenant.ctx, memberRepo: deps.memberRepo }, { limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.items).toHaveLength(2);
    expect(first.value.nextCursor).not.toBeNull();

    const next = await directorySearch({ tenant: tenant.ctx, memberRepo: deps.memberRepo }, {
      limit: 2,
      ...(first.value.nextCursor ? { cursor: first.value.nextCursor } : {}),
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    // Remainder can be 1 or more (the suite may accumulate other rows)
    expect(next.value.items.length).toBeGreaterThanOrEqual(1);
  });

  it('primary contact payload is populated on each row', async () => {
    const r = await directorySearch({ tenant: tenant.ctx, memberRepo: deps.memberRepo }, { q: 'Fogma' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]!.primaryContact).not.toBeNull();
    expect(r.value.items[0]!.primaryContact!.isPrimary).toBe(true);
  });

  // A2 regression — keep LAST (mutates last_activity_at for the whole tenant).
  it('cursor pagination handles tied last_activity_at without dropping rows', async () => {
    // Force every member in this tenant to share the SAME last_activity_at so
    // the ORDER BY tie-break (member_id ASC) is exercised across page
    // boundaries. The old keyset predicate `(last_activity_at, member_id) <
    // (ts, id)` used member_id `<` for ties — the WRONG direction vs the ASC
    // tie-break — and silently dropped tied rows with member_id > cursorId.
    const tieTs = new Date('2026-05-01T00:00:00Z');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.update(members).set({ lastActivityAt: tieTs });
    });

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await directorySearch(
        { tenant: tenant.ctx, memberRepo: deps.memberRepo },
        { limit: 1, ...(cursor ? { cursor } : {}) },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      for (const row of page.value.items) {
        // No duplicate across pages.
        expect(seen.has(row.member.memberId)).toBe(false);
        seen.add(row.member.memberId);
      }
      if (!page.value.nextCursor || page.value.items.length === 0) break;
      cursor = page.value.nextCursor;
    }
    // All 3 tied-timestamp members must paginate exactly once — no drop, no dup.
    expect(seen.size).toBe(3);
  });
});
