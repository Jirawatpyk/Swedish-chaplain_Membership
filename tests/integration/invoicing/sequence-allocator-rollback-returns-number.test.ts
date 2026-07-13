/**
 * CRITICAL-1 / RR-2 guard (Task A.7, Step 6) — the §87 sequential-number
 * allocator MUST be an UPDATE-counter-row (`next_sequence_number += 1`), NOT a
 * Postgres `nextval` sequence.
 *
 * WHY this is load-bearing: idempotent credit-note issuance relies on a lost
 * `source_refund_id` unique-index race ROLLING BACK the whole tx so the §87
 * number it took is RETURNED to the pool — leaving the credit-note stream
 * gap-free (Thai RD §87 no-gaps, ship-blocker). A counter-row UPDATE is
 * transactional: rollback undoes the `+= 1`, so the next allocate takes the
 * SAME number. A `nextval` sequence is NON-transactional: rollback does NOT
 * return the number, so a lost race would BURN it → a permanent §87 gap.
 *
 * This test pins the transactional-return behaviour: allocate a number, roll
 * the tx back, then allocate again in a fresh tx — the SAME number comes out.
 * If a future refactor swaps the counter row for `nextval`, the second allocate
 * would return N+1 and this test would fail loudly, catching the regression
 * before it can silently reintroduce a §87 gap.
 *
 * Live Neon Singapore. Run isolated to avoid shared-Neon concurrent-suite flake.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const FISCAL_YEAR = asFiscalYearUnsafe(2026);

describe('§87 allocator is a rollback-safe counter row (not nextval) — RR-2 guard', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-chamber');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('a rolled-back allocate RETURNS the number to the pool (next allocate re-takes it)', async () => {
    const invoiceRepo = makeDrizzleInvoiceRepo(tenant.ctx.slug);

    // Allocate ONE number, then throw to roll the tx back. The allocator's
    // UPDATE (next += 1) is undone by the rollback, so the number is released.
    let allocatedInRolledBackTx: number | null = null;
    await expect(
      invoiceRepo.withTx(async (tx) => {
        allocatedInRolledBackTx = await postgresSequenceAllocator.allocateNext(tx, {
          tenantId: tenant.ctx.slug,
          documentType: 'credit_note',
          fiscalYear: FISCAL_YEAR,
        });
        // Force ROLLBACK — mirrors the lost `source_refund_id` unique-race path
        // where the CN insert throws after the number was taken.
        throw new Error('force-rollback-after-allocate');
      }),
    ).rejects.toThrow('force-rollback-after-allocate');
    expect(allocatedInRolledBackTx).not.toBeNull();

    // Fresh tx: allocate again. A counter-row UPDATE returns the SAME number
    // (rollback undid the increment). A `nextval` sequence would return +1.
    const allocatedAfterRollback = await invoiceRepo.withTx((tx) =>
      postgresSequenceAllocator.allocateNext(tx, {
        tenantId: tenant.ctx.slug,
        documentType: 'credit_note',
        fiscalYear: FISCAL_YEAR,
      }),
    );

    expect(allocatedAfterRollback).toBe(allocatedInRolledBackTx);

    // And the persisted counter reflects exactly ONE consumed number (the
    // committed second allocate), proving the rolled-back one left no gap.
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ next: tenantDocumentSequences.nextSequenceNumber })
        .from(tenantDocumentSequences)
        .where(
          and(
            eq(tenantDocumentSequences.tenantId, tenant.ctx.slug),
            eq(tenantDocumentSequences.documentType, 'credit_note'),
            eq(tenantDocumentSequences.fiscalYear, FISCAL_YEAR),
          ),
        ),
    );
    // next_sequence_number = allocated + 1 (the committed allocate advanced it
    // by one; the rolled-back allocate contributed nothing).
    expect(row?.next).toBe((allocatedAfterRollback as number) + 1);
  }, 60_000);
});
