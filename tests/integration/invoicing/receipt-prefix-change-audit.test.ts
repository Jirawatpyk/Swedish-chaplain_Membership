/**
 * Round-4 integration test — `tenant_receipt_prefix_changed` audit emit.
 *
 * Validates the §87 forensic-trail emit in `updateTenantInvoiceSettings`
 * (Round-3 fix R3-C1, hardened in Round 4). End-to-end against live
 * Neon Singapore so the migration-0145 enum entry + audit_log INSERT +
 * SELECT-FOR-UPDATE locking + SELECT-FOR-SHARE sequence read all
 * round-trip together.
 *
 * Three scenarios cover the documented `last_sequences` semantics:
 *
 *   1. First-time bootstrap (priorSettings === null) → NO
 *      `tenant_receipt_prefix_changed` row emitted, because there is no
 *      "old" prefix to compare. Only the standard
 *      `tenant_invoice_settings_updated` lands.
 *
 *   2. Flip after ≥1 issued document → emit with
 *      `last_sequences[invoice=2026] = { last_sequence_number: 3 }`
 *      proving the snapshot captured the right boundary.
 *
 *   3. Flip on a tenant that bootstrapped settings but never issued any
 *      document → emit with `last_sequences: []` (no rows in
 *      `tenant_document_sequences` for the tenant). Documents the
 *      "pre-issue tenant" semantic from the use-case JSDoc.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { updateTenantInvoiceSettings } from '@/modules/invoicing/application/use-cases/update-tenant-invoice-settings';
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { postgresSequenceAllocator } from '@/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator';
import { asTenantContext } from '@/modules/tenants';
import { runInTenant } from '@/lib/db';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const BASE_REQUIRED = {
  currencyCode: 'THB',
  vatRate: '0.0700',
  legalNameTh: 'หอการค้าทดสอบ',
  legalNameEn: 'Test Chamber Co., Ltd.',
  taxId: '0000000000000',
  registeredAddressTh: 'ที่อยู่ทดสอบ',
  registeredAddressEn: 'Test Address',
  creditNoteNumberPrefix: 'CN',
} as const;

describe('Round-4 — tenant_receipt_prefix_changed audit emit (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    // R5-SF-M1 — log cleanup errors so CI surfaces leaked test
    // data instead of swallowing FK violations / RLS drift silently.
    await tenant.cleanup().catch((err) => {
      console.warn(
        '[receipt-prefix-change-audit] tenant cleanup failed',
        { tenantSlug: tenant?.ctx?.slug, err },
      );
    });
  });

  it('first-time bootstrap does NOT emit tenant_receipt_prefix_changed', async () => {
    const requestId = `r4-prefix-bootstrap-${randomUUID()}`;
    const result = await updateTenantInvoiceSettings(
      {
        tenantSettingsRepo: drizzleTenantSettingsRepo,
        audit: f4AuditAdapter,
      },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId,
        ...BASE_REQUIRED,
        invoiceNumberPrefix: 'INV',
        receiptNumberingMode: 'separate',
      },
    );
    expect(result.ok).toBe(true);

    // The standard "settings updated" event SHOULD have landed.
    const updatedRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tenant_invoice_settings_updated'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(updatedRows).toHaveLength(1);

    // But NO prefix-changed event for the bootstrap write.
    const prefixRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tenant_receipt_prefix_changed'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(prefixRows).toHaveLength(0);
  }, 30_000);

  it('prefix flip after issuing documents captures correct last_sequences', async () => {
    // R10-T3 — explicit bootstrap inside the test body (not relying on
    // the previous bootstrap test's side effect). With Vitest
    // `--shuffle` or worker-split, Test 1 may not have run yet — the
    // prior cross-test dependency made this case fail silently.
    const bootstrapRequestId = `r4-prefix-flip-bootstrap-${randomUUID()}`;
    const bootstrapResult = await updateTenantInvoiceSettings(
      {
        tenantSettingsRepo: drizzleTenantSettingsRepo,
        audit: f4AuditAdapter,
      },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId: bootstrapRequestId,
        ...BASE_REQUIRED,
        invoiceNumberPrefix: 'INV',
        receiptNumberingMode: 'separate',
      },
    );
    expect(bootstrapResult.ok).toBe(true);

    // 1) Allocate seq 1, 2, 3 under the OLD invoice prefix (INV) for FY 2026.
    const ctx = asTenantContext(tenant.ctx.slug);
    const fy = 2026 as FiscalYear;
    for (let i = 0; i < 3; i++) {
      await runInTenant(ctx, (tx) =>
        postgresSequenceAllocator.allocateNext(tx, {
          tenantId: tenant.ctx.slug,
          documentType: 'invoice',
          fiscalYear: fy,
        }),
      );
    }

    // 2) Flip the invoice prefix INV → TX. Bootstrap above guarantees
    //    priorSettings is non-null regardless of test ordering.
    const requestId = `r4-prefix-flip-${randomUUID()}`;
    const result = await updateTenantInvoiceSettings(
      {
        tenantSettingsRepo: drizzleTenantSettingsRepo,
        audit: f4AuditAdapter,
      },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: user.userId,
        requestId,
        invoiceNumberPrefix: 'TX',
      },
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'tenant_receipt_prefix_changed'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(rows).toHaveLength(1);

    const payload = rows[0]!.payload as {
      changed_prefixes: Record<string, { old: string | null; new: string | null }>;
      receipt_numbering_mode: string;
      last_sequences: ReadonlyArray<{
        document_type: string;
        fiscal_year: number;
        last_sequence_number: number;
      }>;
    };
    expect(payload.changed_prefixes.invoice_number_prefix).toEqual({
      old: 'INV',
      new: 'TX',
    });
    expect(payload.receipt_numbering_mode).toBe('separate');

    // The invoice/FY-2026 last_sequence_number SHOULD be 3 (we allocated
    // 1, 2, 3; next_sequence_number is now 4; last issued = 3).
    const invoice2026 = payload.last_sequences.find(
      (s) => s.document_type === 'invoice' && s.fiscal_year === 2026,
    );
    expect(invoice2026).toBeDefined();
    expect(invoice2026!.last_sequence_number).toBe(3);
  }, 60_000);

  it('prefix flip on pre-issue tenant emits with last_sequences: []', async () => {
    // Fresh tenant that has settings but no allocations.
    const freshTenant = await createTestTenant('test-swecham');
    try {
      // Bootstrap settings (does NOT emit prefix-changed).
      await updateTenantInvoiceSettings(
        {
          tenantSettingsRepo: drizzleTenantSettingsRepo,
          audit: f4AuditAdapter,
        },
        {
          tenantId: freshTenant.ctx.slug,
          actorUserId: user.userId,
          ...BASE_REQUIRED,
          invoiceNumberPrefix: 'INV',
          receiptNumberingMode: 'separate',
        },
      );

      // Flip prefix BEFORE any document is issued.
      const requestId = `r4-prefix-pre-issue-${randomUUID()}`;
      await updateTenantInvoiceSettings(
        {
          tenantSettingsRepo: drizzleTenantSettingsRepo,
          audit: f4AuditAdapter,
        },
        {
          tenantId: freshTenant.ctx.slug,
          actorUserId: user.userId,
          requestId,
          invoiceNumberPrefix: 'PRE',
        },
      );

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, freshTenant.ctx.slug),
            eq(auditLog.eventType, 'tenant_receipt_prefix_changed'),
            eq(auditLog.requestId, requestId),
          ),
        )
        .orderBy(desc(auditLog.timestamp));
      expect(rows).toHaveLength(1);

      const payload = rows[0]!.payload as {
        last_sequences: ReadonlyArray<unknown>;
      };
      // Pre-issue tenant → no rows in tenant_document_sequences yet →
      // empty array. Documents the "pre-issue tenant" semantic in
      // update-tenant-invoice-settings.ts JSDoc.
      expect(payload.last_sequences).toEqual([]);
    } finally {
      // R5-SF-M1 — log cleanup errors instead of swallowing.
      await freshTenant.cleanup().catch((err) => {
        console.warn(
          '[receipt-prefix-change-audit] freshTenant cleanup failed',
          { tenantSlug: freshTenant?.ctx?.slug, err },
        );
      });
    }
  }, 60_000);

  // R10-T5 — coverage for credit-note + receipt prefix flip branches.
  // The use-case builds `changed_prefixes` from three sibling
  // computations; prior integration coverage exercised only the
  // invoice-prefix path. A regression dropping emit on cn/receipt
  // prefix flip would not have been caught.
  it('credit-note prefix flip emits with changed_prefixes.credit_note_number_prefix', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    try {
      const bootstrapResult = await updateTenantInvoiceSettings(
        {
          tenantSettingsRepo: drizzleTenantSettingsRepo,
          audit: f4AuditAdapter,
        },
        {
          tenantId: freshTenant.ctx.slug,
          actorUserId: user.userId,
          ...BASE_REQUIRED,
          invoiceNumberPrefix: 'INV',
          receiptNumberingMode: 'separate',
        },
      );
      expect(bootstrapResult.ok).toBe(true);

      const requestId = `r10-t5-cn-flip-${randomUUID()}`;
      const result = await updateTenantInvoiceSettings(
        {
          tenantSettingsRepo: drizzleTenantSettingsRepo,
          audit: f4AuditAdapter,
        },
        {
          tenantId: freshTenant.ctx.slug,
          actorUserId: user.userId,
          requestId,
          creditNoteNumberPrefix: 'CRED',
        },
      );
      expect(result.ok).toBe(true);

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, freshTenant.ctx.slug),
            eq(auditLog.eventType, 'tenant_receipt_prefix_changed'),
            eq(auditLog.requestId, requestId),
          ),
        );
      expect(rows).toHaveLength(1);
      const payload = rows[0]!.payload as {
        changed_prefixes: Record<string, { old: string | null; new: string | null }>;
      };
      expect(payload.changed_prefixes.credit_note_number_prefix).toEqual({
        old: 'CN',
        new: 'CRED',
      });
      // Only the CN prefix changed — invoice prefix must NOT be in the
      // changed-set (otherwise the use-case is over-emitting).
      expect(payload.changed_prefixes.invoice_number_prefix).toBeUndefined();
    } finally {
      await freshTenant.cleanup().catch((err) => {
        console.warn(
          '[receipt-prefix-change-audit] freshTenant cleanup failed',
          { tenantSlug: freshTenant?.ctx?.slug, err },
        );
      });
    }
  }, 60_000);

  it('receipt prefix flip emits with changed_prefixes.receipt_number_prefix', async () => {
    const freshTenant = await createTestTenant('test-swecham');
    try {
      await updateTenantInvoiceSettings(
        {
          tenantSettingsRepo: drizzleTenantSettingsRepo,
          audit: f4AuditAdapter,
        },
        {
          tenantId: freshTenant.ctx.slug,
          actorUserId: user.userId,
          ...BASE_REQUIRED,
          invoiceNumberPrefix: 'INV',
          // Bootstrap with explicit receipt prefix RE under separate mode
          // so the next flip from RE → RC is observable.
          receiptNumberingMode: 'separate',
          receiptNumberPrefix: 'RE',
        },
      );

      const requestId = `r10-t5-receipt-flip-${randomUUID()}`;
      const result = await updateTenantInvoiceSettings(
        {
          tenantSettingsRepo: drizzleTenantSettingsRepo,
          audit: f4AuditAdapter,
        },
        {
          tenantId: freshTenant.ctx.slug,
          actorUserId: user.userId,
          requestId,
          receiptNumberPrefix: 'RC',
        },
      );
      expect(result.ok).toBe(true);

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, freshTenant.ctx.slug),
            eq(auditLog.eventType, 'tenant_receipt_prefix_changed'),
            eq(auditLog.requestId, requestId),
          ),
        );
      expect(rows).toHaveLength(1);
      const payload = rows[0]!.payload as {
        changed_prefixes: Record<string, { old: string | null; new: string | null }>;
      };
      expect(payload.changed_prefixes.receipt_number_prefix).toEqual({
        old: 'RE',
        new: 'RC',
      });
      expect(payload.changed_prefixes.invoice_number_prefix).toBeUndefined();
      expect(payload.changed_prefixes.credit_note_number_prefix).toBeUndefined();
    } finally {
      await freshTenant.cleanup().catch((err) => {
        console.warn(
          '[receipt-prefix-change-audit] freshTenant cleanup failed',
          { tenantSlug: freshTenant?.ctx?.slug, err },
        );
      });
    }
  }, 60_000);
});
