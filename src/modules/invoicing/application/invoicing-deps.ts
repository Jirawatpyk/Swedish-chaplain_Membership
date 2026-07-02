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
import { env } from '@/lib/env';
import { systemClock } from './ports/clock-port';
import { makeDrizzleInvoiceRepo } from '../infrastructure/repos/drizzle-invoice-repo';
import { makeDrizzleCreditNoteRepo } from '../infrastructure/repos/drizzle-credit-note-repo';
import { drizzleTenantSettingsRepo } from '../infrastructure/repos/drizzle-tenant-settings-repo';
import { postgresSequenceAllocator } from '../infrastructure/adapters/postgres-sequence-allocator';
import { reactPdfRenderAdapter } from '../infrastructure/adapters/react-pdf-render-adapter';
import { vercelBlobAdapter } from '../infrastructure/adapters/vercel-blob-adapter';
import { resendEmailOutboxAdapter } from '../infrastructure/adapters/resend-email-outbox-adapter';
import { receiptPdfRenderEnqueueAdapter } from '../infrastructure/adapters/receipt-pdf-render-enqueue-adapter';
import { memberIdentityAdapter } from '../infrastructure/adapters/member-identity-adapter';
import { makeClamavVirusScanner } from '../infrastructure/adapters/clamav-virus-scanner';
import { planLookupAdapter } from '../infrastructure/adapters/plan-lookup-adapter';
import { eventRegistrationLookupAdapter } from '../infrastructure/adapters/event-registration-lookup-adapter';
import { eventDetailsLookupAdapter } from '../infrastructure/adapters/event-details-lookup-adapter';
import { f4AuditAdapter } from '../infrastructure/adapters/audit-adapter';
import { overdueAuditAdapter } from '../infrastructure/adapters/overdue-audit-adapter';
// `sharp` is a Node-only native dep (libvips → detect-libc →
// child_process). The only place it's needed is the upload-tenant-logo
// route — its dep factory lives in `./make-upload-tenant-logo-deps.ts`,
// imported only by that route. Keeping it OUT of `invoicing-deps.ts`
// is what allows F8 client surfaces (e.g. `tier-filter-select.tsx`)
// that touch the F8 barrel to compile cleanly under Turbopack 16
// without dragging `sharp` into the client bundle.
import { CURRENT_TEMPLATE_VERSION } from '../infrastructure/pdf/template-registry';

import type { CreateInvoiceDraftDeps } from './use-cases/create-invoice-draft';
import type { CreateEventInvoiceDraftDeps } from './use-cases/create-event-invoice-draft';
import type { IssueInvoiceDeps } from './use-cases/issue-invoice';
import type { IssueEventInvoiceAsPaidDeps } from './use-cases/issue-event-invoice-as-paid';
import type { ListInvoicesDeps } from './use-cases/list-invoices';
import type { GetInvoicePdfSignedUrlDeps } from './use-cases/get-invoice-pdf-signed-url';
import type { UploadZeroRateCertDeps } from './use-cases/upload-zero-rate-cert';
import type { GetZeroRateCertSignedUrlDeps } from './use-cases/get-zero-rate-cert-signed-url';
import type { GetReceiptPdfSignedUrlDeps } from './use-cases/get-receipt-pdf-signed-url';
import type { ExportPaidInvoicesCsvDeps } from './use-cases/export-paid-invoices-csv';
import {
  listSucceededPaymentMethods,
  makeListSucceededPaymentMethodsDeps,
} from '@/modules/payments';
import type { PreviewInvoiceDraftDeps } from './use-cases/preview-invoice-draft';
import type { DeleteInvoiceDraftDeps } from './use-cases/delete-invoice-draft';
import type { GetInvoiceDeps } from './use-cases/get-invoice';
import type { RecordPaymentDeps } from './use-cases/record-payment';
import type { RenderReceiptPdfDeps } from './use-cases/render-receipt-pdf';
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

/**
 * 054-event-fee-invoices (Task 6b) — composition for the event-fee draft
 * use-case. The two F6 lookup adapters bridge into the events module through
 * its public barrel; `memberIdentity` resolves the matched-member buyer (+
 * the §86/4 company tax-id gate). No tenant-settings / plan / clock deps —
 * event drafts do not pro-rate and do not read invoice settings (the VAT
 * split happens at ISSUE).
 */
export function makeCreateEventInvoiceDraftDeps(
  tenantId: string,
): CreateEventInvoiceDraftDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    eventDetailsLookup: eventDetailsLookupAdapter,
    memberIdentity: memberIdentityAdapter,
    audit: f4AuditAdapter,
    newUuid: () => randomUUID(),
  };
}

export function makeIssueInvoiceDeps(tenantId: string): IssueInvoiceDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    // 064 S1 — issuance-time refunded re-check for event drafts.
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
    // 088 T022 — new bill→§87-at-payment flow when the flag is on.
    taxAtPayment: env.features.f088TaxAtPayment,
  };
}

/**
 * 064 — composition for the as-paid event issuance use-case. Same adapter
 * wiring as `makeIssueInvoiceDeps`; the optional `onPaidCallbacks` parameter
 * mirrors `makeRecordPaymentDeps` (F8 registers its cycle-completion listener
 * at the route when `FEATURE_F8_RENEWALS` is on — the as-paid flow IS a
 * payment record, so the same cross-module hook applies).
 */
export function makeIssueEventInvoiceAsPaidDeps(
  tenantId: string,
  onPaidCallbacks?: ReadonlyArray<
    (
      evt: import('@/modules/invoicing/domain/f4-invoice-paid-event').F4InvoicePaidEvent,
      tx?: unknown,
    ) => Promise<void>
  >,
): IssueEventInvoiceAsPaidDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    memberIdentity: memberIdentityAdapter,
    // 064 S1 — issuance-time refunded re-check (TOCTOU vs draft-time check).
    eventRegistrationLookup: eventRegistrationLookupAdapter,
    sequenceAllocator: postgresSequenceAllocator,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
    outbox: resendEmailOutboxAdapter,
    currentTemplateVersion: CURRENT_TEMPLATE_VERSION,
    // 088 T022 — mirror record-payment's §87-RC-at-payment behaviour for the
    // event as-paid path when the flag is on (FR-005 / FR-006).
    taxAtPayment: env.features.f088TaxAtPayment,
    ...(onPaidCallbacks !== undefined ? { onPaidCallbacks } : {}),
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

/**
 * 088 US8 UX-B1 (T061e-2) — composition for the OPTIONAL zero-rate cert-scan
 * upload use-case. Own invoicing ClamAV adapter (NOT the broadcasts one —
 * Constitution III), reusing the F4 Vercel Blob adapter for storage. `tenantId`
 * unused in the deps graph today (the scanner + blob are tenant-agnostic
 * adapters); kept in the signature for factory-shape parity + future DI.
 */
export function makeUploadZeroRateCertDeps(_tenantId: string): UploadZeroRateCertDeps {
  return {
    scanner: makeClamavVirusScanner(),
    blob: vercelBlobAdapter,
    clock: systemClock,
  };
}

/**
 * 088 US8 UX-B1 (T061e-3) — composition for the admin cert-view use-case
 * (retrievability of the pinned 10y admin-only cert scan). Same shape as
 * `makeGetInvoicePdfSignedUrlDeps` (repo + blob + audit).
 */
export function makeGetZeroRateCertSignedUrlDeps(
  tenantId: string,
): GetZeroRateCertSignedUrlDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
  };
}

export function makeGetReceiptPdfSignedUrlDeps(tenantId: string): GetReceiptPdfSignedUrlDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
  };
}

/**
 * Phase 3 (F4 receipt-surface plan) — composition for the CSV export
 * use-case. The `paymentMethodLookup` port is wired here with the F5
 * `listSucceededPaymentMethods` use-case so that the use-case file
 * itself imports zero F5 symbols (Constitution III: cross-module
 * wiring belongs to the composition root, not the use-case).
 *
 * Lookup-port failure semantics: F5's `listSucceededPaymentMethods`
 * returns a `Result` whose error union is `never`, so this closure
 * cannot throw under current types. If F5 ever widens the error, the
 * `result.ok` check below short-circuits to an empty map — the CSV
 * still renders, just every row falls back to `'manual'` in the
 * Payment Method column rather than failing the whole export.
 */
export function makeExportPaidInvoicesCsvDeps(
  tenantId: string,
): ExportPaidInvoicesCsvDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    audit: f4AuditAdapter,
    paymentMethodLookup: async (tid, invoiceIds) => {
      const result = await listSucceededPaymentMethods(
        makeListSucceededPaymentMethodsDeps(tid),
        { tenantId: tid, invoiceIds },
      );
      return result.ok
        ? result.value
        : new Map<string, 'card' | 'promptpay'>();
    },
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

// `makeUploadTenantLogoDeps` lives in `./make-upload-tenant-logo-deps.ts`
// — see header comment above for rationale. The F4 barrel re-exports it
// directly from that path so route handlers see no API change.

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
    blob: vercelBlobAdapter,
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
 * @param onPaidCallbacks - optional list of cross-module on-paid hooks.
 *   F8 Phase 2 Wave A (T008) — fired inside the same withTx after
 *   applyPayment + audit + outbox + registration-fee flip succeed,
 *   before the tx commits. Any rejection rolls back the whole tx.
 *   F8's composition root will register a `complete-cycle-on-paid`
 *   callback here per research.md R12. Defaults to undefined (no
 *   callbacks) so existing F4 admin manual mark-paid + F5 webhook
 *   call sites are unchanged when callers don't pass the parameter.
 *
 *   I3 review-fix (Phase 5 backlog close): the second `tx` parameter
 *   is the F4-internal Drizzle tx handle, threaded so listeners that
 *   touch other tables (F8's mark-cycle-complete) can participate in
 *   the SAME transaction instead of opening a separate `runInTenant`
 *   that commits independently. The handle is typed `unknown` to keep
 *   the cross-module contract framework-free (Constitution Principle
 *   III); listeners cast back to their own internal `TenantTx` brand.
 *   Listeners that don't need the tx may simply ignore the parameter.
 */
export function makeRecordPaymentDeps(
  tenantId: string,
  externalTx?: unknown,
  onPaidCallbacks?: ReadonlyArray<
    (
      evt: import('@/modules/invoicing/domain/f4-invoice-paid-event').F4InvoicePaidEvent,
      tx?: unknown,
    ) => Promise<void>
  >,
): RecordPaymentDeps {
  // Async-receipt-PDF feature flag → enqueue port MUST be wired or the
  // use-case will flip invoices to `receipt_pdf_status='pending'` and
  // never enqueue the render task → invoice stuck in pending forever
  // with no audit event surfacing the failure. Fail loudly at deps
  // construction so an env-flag mistake never reaches production.
  if (env.features.f5AsyncReceiptPdf && !receiptPdfRenderEnqueueAdapter) {
    throw new Error(
      'makeRecordPaymentDeps: asyncReceiptPdf=true requires receiptPdfRenderEnqueue adapter to be wired',
    );
  }

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
    receiptPdfRenderEnqueue: receiptPdfRenderEnqueueAdapter,
    asyncReceiptPdf: env.features.f5AsyncReceiptPdf,
    // 088 T022 — mint the §86/4 §87 RC receipt number at payment when on.
    taxAtPayment: env.features.f088TaxAtPayment,
    ...(onPaidCallbacks !== undefined ? { onPaidCallbacks } : {}),
  };
}

/**
 * T166-05 — composition root for the async render-receipt-pdf
 * worker. Reuses the same infra adapters as `recordPayment` since the
 * render path is identical — only the trigger differs (worker vs
 * webhook).
 */
export function makeRenderReceiptPdfDeps(
  tenantId: string,
): RenderReceiptPdfDeps {
  return {
    invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
    tenantSettingsRepo: drizzleTenantSettingsRepo,
    pdfRender: reactPdfRenderAdapter,
    blob: vercelBlobAdapter,
    audit: f4AuditAdapter,
    clock: systemClock,
  };
}
