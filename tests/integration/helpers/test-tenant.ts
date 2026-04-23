/**
 * Integration-test tenant lifecycle helper.
 *
 * Creates isolated test tenant contexts with UUID-suffixed slugs so
 * parallel CI runs + multiple tests in the same suite never collide
 * (critique E8). Each context comes with a `cleanup` function that
 * deletes every row the test inserted for that tenant from
 * `membership_plans`, `tenant_fee_config`, and `audit_log`.
 *
 * Usage:
 *
 *   const { ctx, cleanup } = await createTestTenant('test-swecham');
 *   try {
 *     // insert rows via runInTenant(ctx, ...)
 *   } finally {
 *     await cleanup();
 *   }
 *
 * Important: `cleanup` runs as `neondb_owner` (BYPASS RLS) so it can
 * see + delete rows from any tenant's namespace. The app never uses
 * this path in production — only the test suite and the future F13
 * super-admin scan do.
 *
 * Never import from outside `tests/integration/**`.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import {
  auditLog,
  emailChangeTokens,
  notificationsOutbox,
} from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';
import { creditNotes } from '@/modules/invoicing/infrastructure/db/schema-credit-notes';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { tenantDocumentSequences } from '@/modules/invoicing/infrastructure/db/schema-tenant-document-sequences';
import {
  payments,
  refunds,
  tenantPaymentSettings,
  processorEvents,
} from '@/modules/payments/infrastructure/schema';

export interface TestTenant {
  readonly ctx: TenantContext;
  readonly cleanup: () => Promise<void>;
}

export type TestTenantPrefix = 'test-swecham' | 'test-chamber' | 'test';

/**
 * Mint a fresh TenantContext with a UUID-suffixed slug. The slug is
 * guaranteed unique across concurrent CI runs because the suffix is a
 * fresh UUIDv4 on every call.
 *
 * Slug format: `{prefix}-{uuid-first-8-chars}`
 * Example:     `test-swecham-a1b2c3d4`
 *
 * Fits in the 63-char limit for DNS labels. The database has no FK
 * to a tenants table in F2, so we can invent tenant IDs freely.
 */
export async function createTestTenant(
  prefix: TestTenantPrefix = 'test',
): Promise<TestTenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const slug = `${prefix}-${suffix}`;
  const ctx = asTenantContext(slug);

  const cleanup = async (): Promise<void> => {
    // Run as the BYPASSRLS owner so the DELETE sees the rows regardless
    // of RLS — the whole point of the helper is to wipe everything this
    // tenant inserted. Plain `db.delete(...)` uses the owner role.
    // Order matters: contacts → members (FK constraint), then plans → fee_config.
    // F3 US3.b — tokens + outbox rows carry tenantId; clean them up
    // before deleting contacts (FK on contact_id in email_change_tokens).
    await db
      .delete(emailChangeTokens)
      .where(eq(emailChangeTokens.tenantId, slug));
    await db
      .delete(notificationsOutbox)
      .where(eq(notificationsOutbox.tenantId, slug));
    // F4 cleanup — delete in FK order: credit_notes → invoice_lines (CASCADE
    // from invoices) → invoices → settings + sequences. invoice_lines are
    // CASCADE-deleted by `invoices_invoice_fk ON DELETE CASCADE` so an
    // explicit `delete(invoiceLines)` is redundant but kept for clarity.
    // F5 cleanup — delete in FK order: refunds → payments (FK to payments.id
    // + composite to invoices.tenant_id/invoice_id) → credit_notes (see F4
    // block below for CN cleanup — payments.refunds.creditNoteId back-ref
    // must be cleared before F4 deletes the CN row). processorEvents has
    // no outbound FK; tenantPaymentSettings is keyed by tenant_id only.
    await db.delete(refunds).where(eq(refunds.tenantId, slug));
    await db.delete(payments).where(eq(payments.tenantId, slug));
    await db.delete(processorEvents).where(eq(processorEvents.tenantId, slug));
    await db
      .delete(tenantPaymentSettings)
      .where(eq(tenantPaymentSettings.tenantId, slug));
    await db.delete(creditNotes).where(eq(creditNotes.tenantId, slug));
    await db.delete(invoiceLines).where(eq(invoiceLines.tenantId, slug));
    await db.delete(invoices).where(eq(invoices.tenantId, slug));
    await db.delete(tenantDocumentSequences).where(eq(tenantDocumentSequences.tenantId, slug));
    await db.delete(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, slug));
    await db.delete(contacts).where(eq(contacts.tenantId, slug));
    await db.delete(members).where(eq(members.tenantId, slug));
    await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug));
    // R9 — tenant_fee_config DROPPED (migration 0029). Fiscal config
    // lives in tenant_invoice_settings which is cleaned above.
    // audit_log has an append-only trigger that BLOCKS DELETE — so we
    // skip audit cleanup here. Test-created audit rows accumulate as
    // pollution but are scoped to the test tenant slug so they are
    // harmless. A disposable Neon branch is the right long-term fix.
  };

  return { ctx, cleanup };
}

/**
 * Convenience: spin up two test tenants at once for cross-tenant
 * isolation tests. Each has an independent UUID-suffixed slug.
 */
export async function createTwoTestTenants(): Promise<{
  a: TestTenant;
  b: TestTenant;
}> {
  const a = await createTestTenant('test-swecham');
  const b = await createTestTenant('test-chamber');
  return { a, b };
}

/**
 * Delete any audit_log pollution across ALL test-prefixed tenants.
 * The append-only trigger is bypassed by running as a role that has
 * RLS bypass — but we can't bypass the trigger itself without dropping
 * it. Kept here as a placeholder for future hardening; currently a no-op.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function purgeTestAuditRows(_prefix: TestTenantPrefix): Promise<void> {
  // Intentionally no-op — see the cleanup comment above. The suppression
  // reference ensures this file is valid TypeScript even with unused params.
  void sql;
  void auditLog;
  void and;
  void inArray;
  void or;
}
