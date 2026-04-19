/**
 * T040 — Invoicing composition root.
 *
 * Binds Application ports to Infrastructure adapters. Route handlers +
 * server actions import use cases + the composition builders from here.
 *
 * Factories (not singletons) for repos that need per-request tenant
 * context (invoice repo); stateless adapters are module-level constants.
 */
import { randomUUID } from 'node:crypto';
import { systemClock } from './ports/clock-port';
import { makeDrizzleInvoiceRepo } from '../infrastructure/repos/drizzle-invoice-repo';
import { drizzleTenantSettingsRepo } from '../infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '../infrastructure/adapters/postgres-sequence-allocator';
import { reactPdfRenderAdapter } from '../infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '../infrastructure/adapters/vercel-blob-adapter';
import { resendEmailOutboxAdapter } from '../infrastructure/adapters/resend-email-outbox-adapter';
import { memberIdentityAdapter } from '../infrastructure/adapters/member-identity-adapter';
import { planLookupAdapter } from '../infrastructure/adapters/plan-lookup-adapter';
import { f2FeeConfigAdapter } from '../infrastructure/adapters/fee-config-adapter';
import { f4AuditAdapter } from '../infrastructure/adapters/audit-adapter';
import { CURRENT_TEMPLATE_VERSION } from '../infrastructure/pdf/template-registry';

import type { CreateInvoiceDraftDeps } from './use-cases/create-invoice-draft';
import type { IssueInvoiceDeps } from './use-cases/issue-invoice';
import type { ListInvoicesDeps } from './use-cases/list-invoices';
import type { GetInvoicePdfSignedUrlDeps } from './use-cases/get-invoice-pdf-signed-url';
import type { PreviewInvoiceDraftDeps } from './use-cases/preview-invoice-draft';
import type { DeleteInvoiceDraftDeps } from './use-cases/delete-invoice-draft';
import type { GetInvoiceDeps } from './use-cases/get-invoice';
import type { RecordPaymentDeps } from './use-cases/record-payment';
import type { UpdateInvoiceDraftDeps } from './use-cases/update-invoice-draft';

export function makeCreateInvoiceDraftDeps(tenantId: string): CreateInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    planLookup: planLookupAdapter,
    feeConfig: f2FeeConfigAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    newUuid: () => randomUUID(),
  };
}

export function makeIssueInvoiceDeps(tenantId: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
  };
}

export function makeListInvoicesDeps(tenantId: string): ListInvoicesDeps {
  return { invoiceRepo: makeDrizzleInvoiceRepo(tenantId) };
}

export function makeGetInvoicePdfSignedUrlDeps(tenantId: string): GetInvoicePdfSignedUrlDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
  };
}

export function makeUpdateTenantInvoiceSettingsDeps(): {
  tenantSettingsRepo: typeof drizzleTenantSettingsRepo;
  audit: typeof f4AuditAdapter;
} {
  return {
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    audit: f4AuditAdapter,
  };
}

export function makeUploadTenantLogoDeps(): {
  blob: typeof vercelBlobAdapter;
  audit: typeof f4AuditAdapter;
} {
  return {
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
  };
}

/**
 * R7-B5 — bootstrap-guard helper for the invoice list page.
 *
 * Returns `true` when the tenant's invoice-settings row is present
 * AND populated enough to allow an issue. `false` signals the list
 * page to render a "Configure Invoicing" empty state instead of the
 * hidden-but-functional table (FR-010 + US4 AS5).
 *
 * Implemented via the same `getForIssue` port that `issue-invoice`
 * uses, so the UI guard and the API guard share one source of truth.
 */
export async function isTenantInvoiceSetupComplete(tenantId: string): Promise<boolean> {
  const settings = await drizzleTenantSettingsRepo.getForIssue(tenantId);
  return settings !== null;
}

export function makePreviewInvoiceDraftDeps(tenantId: string): PreviewInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    pdfRender: reactPdfRenderAdapter,
    clock: systemClock,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
    // R7-W1 — wire audit so the preview route can emit
    // `invoice_cross_tenant_probe` on not-found when actor context is
    // passed in the input.
    audit: f4AuditAdapter,
  };
}

export function makeDeleteInvoiceDraftDeps(tenantId: string): DeleteInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    audit: f4AuditAdapter,
  };
}

export function makeGetInvoiceDeps(tenantId: string): GetInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    // Wire audit so cross-tenant probes emit when actor context is
    // supplied. Detail-page callers SHOULD pass actor; background
    // reads (sweeper, reconciliation) can omit it safely.
    audit: f4AuditAdapter,
  };
}

export function makeUpdateInvoiceDraftDeps(tenantId: string): UpdateInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    audit: f4AuditAdapter,
  };
}

export function makeRecordPaymentDeps(tenantId: string): RecordPaymentDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
    memberIdentity: memberIdentityAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
  };
}
