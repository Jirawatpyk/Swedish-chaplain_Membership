/**
 * Deliberate-duplicate guard — adapter-level behaviour against live Neon.
 *
 * The unit suite pins the use-case's decisions with a stubbed port. What it
 * CANNOT prove is the SQL predicate itself, which is where the rule actually
 * lives:
 *
 *   - a live membership invoice BLOCKS a second draft for the same
 *     (tenant, member, plan_year);
 *   - a VOID one does NOT — an invoice voided for correction has to stay
 *     freely re-issuable, or a mis-issued document would fence the member out
 *     of being billed at all;
 *   - an explicit acknowledgement proceeds AND lands in the audit payload, so
 *     "who deliberately created a duplicate, and against which invoice" is
 *     answerable later;
 *   - the read is tenant-scoped (RLS + the explicit `tenant_id` predicate),
 *     so another tenant's invoice for a same-id member never blocks.
 *
 * Live Neon Singapore via .env.local.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  createInvoiceDraft,
  type CreateInvoiceDraftInput,
} from '@/modules/invoicing/application/use-cases/create-invoice-draft';
import { makeCreateInvoiceDraftDeps } from '@/modules/invoicing/application/invoicing-deps';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_YEAR = 2026;
const ANNUAL_FEE = 5_000_000;

describe('duplicate membership-bill guard (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  /** A fresh member per test — the guard is per-(tenant, member, plan_year). */
  async function seedMember(label: string): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Dup Guard ${label}`,
        country: 'TH',
        planId,
        planYear: PLAN_YEAR,
        registrationFeePaid: true,
        registrationDate: '2024-06-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Dup',
        lastName: label,
        email: `dup-${label}-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
      });
    });
    return memberId;
  }

  function draftInput(
    memberId: string,
    overrides: Partial<CreateInvoiceDraftInput> = {},
  ): CreateInvoiceDraftInput {
    return {
      tenantId: tenant.ctx.slug,
      actorUserId: user.userId,
      requestId: `dup-guard-${randomUUID().slice(0, 8)}`,
      memberId,
      planId,
      planYear: PLAN_YEAR,
      autoEmailOnIssue: false,
      ...overrides,
    } as CreateInvoiceDraftInput;
  }

  function draft(memberId: string, overrides: Partial<CreateInvoiceDraftInput> = {}) {
    return createInvoiceDraft(
      makeCreateInvoiceDraftDeps(tenant.ctx.slug),
      draftInput(memberId, overrides),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    await seedTenantFiscal({ tenant, vatRate: '0.0700', registrationFeeSatang: 0n });

    planId = `dup-guard-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Dup Guard Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: ANNUAL_FEE,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db.delete(invoices).where(eq(invoices.tenantId, tenant.ctx.slug)).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('a live membership invoice BLOCKS a second draft for the same plan year', async () => {
    const memberId = await seedMember('blocks');

    const first = await draft(memberId);
    expect(first.ok).toBe(true);

    const second = await draft(memberId);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('duplicate_membership_invoice');
    if (second.error.code !== 'duplicate_membership_invoice') throw new Error('wrong code');
    // Points at the invoice that actually exists — not a stale/other id.
    expect(second.error.existingInvoiceId).toBe(
      first.ok ? String(first.value.invoiceId) : '',
    );
    // A draft carries no §87 number and no frozen total yet.
    expect(second.error.existingStatus).toBe('draft');
    expect(second.error.existingDocumentNumber).toBeNull();
  }, 60_000);

  it('a VOID invoice does NOT block — a voided document stays re-issuable', async () => {
    const memberId = await seedMember('void');
    const voidedInvoiceId = randomUUID();

    // A fully-coherent VOIDED membership invoice — the shape a §86/4 has
    // after being voided for correction. Forged by INSERT rather than by
    // flipping a draft, because `invoices_draft_has_no_number` and
    // `invoices_non_draft_has_snapshots` both require a non-draft row to be
    // fully numbered + snapshotted; a draft cannot legally become void.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: voidedInvoiceId,
        memberId,
        planId,
        planYear: PLAN_YEAR,
        invoiceSubject: 'membership',
        eventId: null,
        eventRegistrationId: null,
        status: 'void',
        draftByUserId: user.userId,
        fiscalYear: 2099,
        sequenceNumber: 99101,
        documentNumber: 'SC-2099-099101',
        subtotalSatang: 100000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7000n,
        totalSatang: 107000n,
        issueDate: '2026-06-01',
        dueDate: '2026-07-01',
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: { legal_name_en: 'Test Chamber', tax_id: '0000000000000' },
        memberIdentitySnapshot: {
          legal_name: 'Dup Guard void',
          tax_id: '1234567890123',
          address: 'TH',
          primary_contact_name: 'Dup',
          primary_contact_email: 'dup-void@example.com',
        },
        pdfBlobKey: `invoices/${voidedInvoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
        pdfDocKind: 'invoice',
        voidedAt: new Date(),
        voidReason: 'voided for correction (test)',
        voidedByUserId: user.userId,
      }),
    );

    // The voided document must not fence the member out of being billed.
    const afterVoid = await draft(memberId);
    if (!afterVoid.ok) {
      throw new Error(`void should not block: ${JSON.stringify(afterVoid.error)}`);
    }

    // Control, same member and plan year: now that a LIVE draft exists, the
    // next attempt IS refused — proving the previous success was caused by
    // `status='void'` and not by the predicate failing to match at all.
    const blocked = await draft(memberId);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    if (blocked.error.code !== 'duplicate_membership_invoice') throw new Error('wrong code');
    // And it points at the LIVE draft, never the voided row.
    expect(blocked.error.existingInvoiceId).toBe(String(afterVoid.value.invoiceId));
    expect(blocked.error.existingInvoiceId).not.toBe(voidedInvoiceId);
  }, 60_000);

  it('an explicit acknowledgement proceeds and is recorded in the audit payload', async () => {
    const memberId = await seedMember('ack');

    const first = await draft(memberId);
    if (!first.ok) throw new Error('seed draft failed');

    const second = await draft(memberId, { acknowledgeDuplicate: true });
    if (!second.ok) throw new Error(`ack should proceed: ${JSON.stringify(second.error)}`);
    expect(String(second.value.invoiceId)).not.toBe(String(first.value.invoiceId));

    // "Who deliberately created a duplicate, and against which existing
    // invoice" — answerable from the audit trail alone.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ actorUserId: auditLog.actorUserId, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_draft_created'),
          ),
        ),
    );
    const overrideRow = rows.find(
      (r) =>
        (r.payload as Record<string, unknown> | null)?.invoice_id ===
        String(second.value.invoiceId),
    );
    expect(overrideRow).toBeDefined();
    const payload = overrideRow!.payload as Record<string, unknown>;
    expect(payload.acknowledged_duplicate).toBe(true);
    expect(payload.acknowledged_duplicate_of_invoice_id).toBe(String(first.value.invoiceId));
    expect(overrideRow!.actorUserId).toBe(user.userId);

    // The FIRST draft was not a duplicate — its row must say so positively,
    // so the two cases are distinguishable in the trail.
    const firstRow = rows.find(
      (r) =>
        (r.payload as Record<string, unknown> | null)?.invoice_id ===
        String(first.value.invoiceId),
    );
    expect((firstRow!.payload as Record<string, unknown>).acknowledged_duplicate).toBe(false);
  }, 60_000);

  it('refusing writes NOTHING — no draft row, no audit row', async () => {
    // `err(...)` inside the use-case's `withTx` callback does NOT throw: the
    // transaction COMMITS. Prove the refusal left no trace behind.
    const memberId = await seedMember('nowrite');
    await draft(memberId);

    const before = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberId))),
    );
    expect(before).toHaveLength(1);

    const refused = await draft(memberId);
    expect(refused.ok).toBe(false);

    const after = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId })
        .from(invoices)
        .where(and(eq(invoices.tenantId, tenant.ctx.slug), eq(invoices.memberId, memberId))),
    );
    expect(after).toHaveLength(1);

    const auditRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'invoice_draft_created'),
          ),
        ),
    );
    const forThisMember = auditRows.filter(
      (r) => (r.payload as Record<string, unknown> | null)?.member_id === memberId,
    );
    expect(forThisMember).toHaveLength(1);
  }, 60_000);

  it('a DIFFERENT plan year does not block — the key includes plan_year', async () => {
    const memberId = await seedMember('year');

    const first = await draft(memberId);
    expect(first.ok).toBe(true);

    // The plan catalogue row must exist for the other year (invoices_plan_fk).
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Dup Guard Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        annualFeeMinorUnits: ANNUAL_FEE,
        planYear: PLAN_YEAR + 1,
      }),
    );

    const nextYear = await draft(memberId, { planYear: PLAN_YEAR + 1 });
    if (!nextYear.ok) {
      throw new Error(`next plan year should not block: ${JSON.stringify(nextYear.error)}`);
    }
  }, 60_000);
});
