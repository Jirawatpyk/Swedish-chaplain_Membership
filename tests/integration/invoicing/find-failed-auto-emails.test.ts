/**
 * B7 / FR-026 — integration test for `findFailedAutoEmailsByInvoice` (the
 * invoice-detail delivery-failure banner source). Live Neon Singapore,
 * throwaway tenants, direct outbox inserts (no FK to seed). Covers:
 *   - a permanently_failed invoice_auto_email row for the invoice is returned;
 *   - a `pending` row (still mid-retry) is excluded;
 *   - a permanently_failed row for a DIFFERENT invoice is excluded;
 *   - a cross-tenant failed row does not leak (tenant filter + FORCE RLS).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { findFailedAutoEmailsByInvoice } from '@/modules/invoicing/infrastructure/adapters/resend-email-outbox-adapter';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const INVOICE_X = randomUUID();
const INVOICE_Y = randomUUID();

async function insertOutbox(
  slug: string,
  opts: {
    invoiceId: string;
    status: 'pending' | 'permanently_failed';
    toEmail: string;
    lastError?: string | null;
  },
): Promise<void> {
  await runInTenant({ slug } as never, async (tx) => {
    await tx.execute(sql`
      INSERT INTO notifications_outbox
        (tenant_id, notification_type, to_email, locale, context_data,
         status, attempts, last_error, next_retry_at)
      VALUES
        (${slug},
         'invoice_auto_email'::notification_type,
         ${opts.toEmail},
         'en',
         ${JSON.stringify({ event_type: 'invoice_issued', invoice_id: opts.invoiceId })}::jsonb,
         ${opts.status}::outbox_status,
         ${opts.status === 'permanently_failed' ? 5 : 0},
         ${opts.lastError ?? null},
         now())
    `);
  });
}

describe('findFailedAutoEmailsByInvoice — integration (B7 / FR-026)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    // tenantA: the failed row we expect to surface for INVOICE_X.
    await insertOutbox(tenantA.ctx.slug, {
      invoiceId: INVOICE_X,
      status: 'permanently_failed',
      toEmail: 'failed@example.com',
      lastError: 'Bounced: mailbox unavailable',
    });
    // tenantA: a still-pending row for INVOICE_X — must be EXCLUDED.
    await insertOutbox(tenantA.ctx.slug, {
      invoiceId: INVOICE_X,
      status: 'pending',
      toEmail: 'pending@example.com',
    });
    // tenantA: a failed row for a DIFFERENT invoice — must be EXCLUDED.
    await insertOutbox(tenantA.ctx.slug, {
      invoiceId: INVOICE_Y,
      status: 'permanently_failed',
      toEmail: 'other-invoice@example.com',
    });
    // tenantB: a failed row for INVOICE_X — must NOT leak into tenantA's read.
    await insertOutbox(tenantB.ctx.slug, {
      invoiceId: INVOICE_X,
      status: 'permanently_failed',
      toEmail: 'cross-tenant@example.com',
    });
  });

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('returns only the permanently_failed row for the invoice', async () => {
    const rows = await findFailedAutoEmailsByInvoice(INVOICE_X, tenantA.ctx.slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientEmail).toBe('failed@example.com');
    expect(rows[0]!.eventType).toBe('invoice_issued');
    expect(rows[0]!.lastError).toBe('Bounced: mailbox unavailable');
    expect(typeof rows[0]!.failedAt).toBe('string');
  });

  it('excludes pending rows and other invoices', async () => {
    // INVOICE_Y has a failed row; INVOICE_X has a pending row — both proven
    // by the first test returning exactly 1 (the X failed row only).
    const yRows = await findFailedAutoEmailsByInvoice(INVOICE_Y, tenantA.ctx.slug);
    expect(yRows).toHaveLength(1);
    expect(yRows[0]!.recipientEmail).toBe('other-invoice@example.com');
  });

  it('does not leak a cross-tenant failed row (tenant filter + RLS)', async () => {
    // tenantB has a failed row for INVOICE_X, but tenantA must not see it.
    const aRows = await findFailedAutoEmailsByInvoice(INVOICE_X, tenantA.ctx.slug);
    expect(
      aRows.some((r) => r.recipientEmail === 'cross-tenant@example.com'),
    ).toBe(false);
    // And tenantB sees only its own.
    const bRows = await findFailedAutoEmailsByInvoice(INVOICE_X, tenantB.ctx.slug);
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.recipientEmail).toBe('cross-tenant@example.com');
  });
});
