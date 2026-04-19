/**
 * T060 — Integration perf: SC-002 directory substring search.
 *
 * Target: p95 < 500ms substring search at 5,000-row tenant, backed
 * by the pg_trgm GIN indexes declared in migration 0009.
 *
 * Gated by RUN_PERF=1 so the 5,000-row seed doesn't run on every CI
 * tick. Skip is observable in the test report.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/members/search-perf.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const RUN_PERF = process.env.RUN_PERF === '1';

// Deterministic word bank so a substring query has real hit frequency.
const WORDS = [
  'Fogma',
  'Scandix',
  'Bangkok',
  'Alumni',
  'Chamber',
  'Nordic',
  'Solutions',
  'Trading',
  'Industries',
  'Consulting',
  'Global',
  'Ventures',
  'Group',
  'Logistics',
  'Media',
  'Studios',
];

function pickCompanyName(idx: number): string {
  const a = WORDS[idx % WORDS.length]!;
  const b = WORDS[(idx * 7 + 3) % WORDS.length]!;
  return `${a} ${b} ${idx}`;
}

describe('directory search perf — SC-002 (T060)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
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
        planId: 'test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: '' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        benefitMatrix: {
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
        },
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  it.skipIf(!RUN_PERF)(
    'substring p95 < 500ms at 5,000-row tenant',
    async () => {
      // Seed 5,000 members in batches of 250.
      const batchSize = 250;
      const total = 5_000;
      for (let offset = 0; offset < total; offset += batchSize) {
        const memberRows = Array.from({ length: batchSize }, (_, i) => ({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          companyName: pickCompanyName(offset + i),
          country: 'TH',
          planId: 'test-plan',
          planYear: 2026,
          status: 'active' as const,
        }));
        await runInTenant(tenant.ctx, async (tx) => {
          const inserted = await tx.insert(members).values(memberRows).returning({
            memberId: members.memberId,
          });
          // One primary contact per member so the directory EXISTS
          // subquery has something to hit (first_name substring test).
          const contactRows = inserted.map((m, i) => ({
            tenantId: tenant.ctx.slug,
            contactId: randomUUID(),
            memberId: m.memberId,
            firstName: pickCompanyName(offset + i).split(' ')[0] ?? 'Test',
            lastName: 'Perf',
            email: `perf-${offset + i}-${randomUUID().slice(0, 6)}@example.com`,
            preferredLanguage: 'en' as const,
            isPrimary: true,
          }));
          await tx.insert(contacts).values(contactRows);
        });
      }

      const queries = ['Fogma', 'Nordic', 'Group', 'Trading', 'Studios'];
      const runOnce = async () => {
        const q = queries[Math.floor(Math.random() * queries.length)]!;
        const t0 = performance.now();
        const result = await directorySearch({ tenant: tenant.ctx, memberRepo: buildMembersDeps(tenant.ctx).memberRepo }, { q, limit: 50 });
        const elapsed = performance.now() - t0;
        expect(result.ok).toBe(true);
        return elapsed;
      };

      // 20 warmup + 100 measurements
      for (let i = 0; i < 20; i += 1) await runOnce();
      const samples: number[] = [];
      for (let i = 0; i < 100; i += 1) samples.push(await runOnce());
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(0.95 * samples.length) - 1]!;
      const p50 = samples[Math.ceil(0.50 * samples.length) - 1]!;
      console.log(
        `[T060] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms over ${samples.length} samples`,
      );
      expect(p95).toBeLessThan(500);
    },
    600_000,
  );

  // Always-run smoke so the test file is not dead weight when
  // RUN_PERF is unset — asserts the query works at tiny scale.
  it('smoke: substring search returns rows at small scale', async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: randomUUID(),
        companyName: 'Nordic Smoke Co',
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'active',
      });
    });
    const result = await directorySearch({ tenant: tenant.ctx, memberRepo: buildMembersDeps(tenant.ctx).memberRepo }, { q: 'Nordic', limit: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
