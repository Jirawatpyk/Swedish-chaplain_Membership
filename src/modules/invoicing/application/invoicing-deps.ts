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
import { makeDrizzleCreditNoteRepo } from '../infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '../infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '../infrastructure/adapters/postgres-sequence-allocator';
import { reactPdfRenderAdapter } from '../infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '../infrastructure/adapters/vercel-blob-adapter';
import { resendEmailOutboxAdapter } from '../infrastructure/adapters/resend-email-outbox-adapter';
import { memberIdentityAdapter } from '../infrastructure/adapters/member-identity-adapter';
import { planLookupAdapter } from '../infrastructure/adapters/plan-lookup-adapter';
import { f4AuditAdapter } from '../infrastructure/adapters/audit-adapter';
import { overdueAuditAdapter } from '../infrastructure/adapters/overdue-audit-adapter';
import { sharpImageReencodeAdapter } from '../infrastructure/adapters/sharp-image-reencode-adapter';
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
import type { IssueCreditNoteDeps } from './use-cases/issue-credit-note';
import type { VoidInvoiceDeps } from './use-cases/void-invoice';
import type { GetCreditNoteDeps } from './use-cases/get-credit-note';
import type { GetCreditNotePdfSignedUrlDeps } from './use-cases/get-credit-note-pdf-signed-url';
import type { ResendPdfDeps } from './use-cases/resend-pdf';

export function makeCreateInvoiceDraftDeps(tenantId: string): CreateInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    planLookup: planLookupAdapter,
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

export function makeListInvoicesByMemberDeps(tenantId: string): import('./use-cases/list-invoices-by-member').ListInvoicesByMemberDeps {
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
  imageReencode: typeof sharpImageReencodeAdapter;
} {
  return {
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    imageReencode: sharpImageReencodeAdapter,
  };
}

/**
 * R7 consolidation — F2 plan module calls this when it needs to
 * render VAT-inclusive prices / apply a registration fee. Returns
 * null when the tenant hasn't completed invoice-settings setup yet;
 * F2 callers render a placeholder in that case.
 */
export function makeGetTenantTaxPolicyDeps(): {
  tenantSettingsRepo: typeof drizzleTenantSettingsRepo;
} {
  return { tenantSettingsRepo: drizzleTenantSettingsRepo };
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

export function makeIssueCreditNoteDeps(tenantId: string): IssueCreditNoteDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
  };
}

export function makeGetCreditNoteDeps(tenantId: string): GetCreditNoteDeps {
  return {
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    audit: f4AuditAdapter,
  };
}

/** G-3 — admin CN directory deps. Repo only; no audit / clock needed. */
export function makeListCreditNotesDeps(tenantId: string): {
  creditNoteRepo: ReturnType<typeof makeDrizzleCreditNoteRepo>;
} {
  return { creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId) };
}

export function makeGetCreditNotePdfSignedUrlDeps(
  tenantId: string,
): GetCreditNotePdfSignedUrlDeps {
  return {
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
  };
}

export function makeVoidInvoiceDeps(tenantId: string): VoidInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
  };
}

/**
 * T107 — resend-pdf composition. Wires invoice repo + credit-note repo
 * + audit + outbox. No clock/pdf-render needed because resend uses the
 * pinned blob key + templateVersion from the stored document (no
 * re-render; no seq allocation).
 */
/**
 * T109 — Overdue detection emit dep. Pure derive has no deps; only
 * the opportunistic audit emit needs the adapter. Kept as a factory
 * (rather than re-exporting the const) for future DI flexibility.
 */
export function makeOverdueAuditPort() {
  return overdueAuditAdapter;
}

/**
 * T120 — expose the generic F4 audit adapter for route handlers that
 * need to emit standalone audit rows (no mutating tx involved), e.g.
 * the host-header MTA dual-bind probe in PATCH /api/tenant-invoice-settings.
 * Non-happy-path routes use this to emit `*_cross_tenant_probe` events
 * without needing to plumb a full use-case dependency graph.
 */
export function makeF4AuditPort() {
  return f4AuditAdapter;
}

export function makeResendPdfDeps(tenantId: string): ResendPdfDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    audit: f4AuditAdapter,
    outbox: resendEmailOutboxAdapter,
  };
}

/**
 * @param tenantId - tenant slug the deps are bound to.
 * @param externalTx - optional caller-owned Drizzle tx handle. When
 *   supplied, the invoice repo's `withTx` executes inline against this
 *   tx instead of opening its own. Used by the F5 → F4 invoicing-bridge
 *   to keep the payment-row update and the invoice `issued → paid` flip
 *   in a SINGLE transaction (Reliability D-03, Group E2b).
 */
export function makeRecordPaymentDeps(
  tenantId: string,
  externalTx?: unknown,
): RecordPaymentDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId, externalTx),
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
