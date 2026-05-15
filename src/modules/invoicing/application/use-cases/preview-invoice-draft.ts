/**
 * T036 — preview-invoice-draft use case (FR-001a, F4).
 *
 * Renders a WATERMARKED PDF for a draft invoice. NO sequence
 * allocation, NO Blob write, NO audit row — pure read-through render.
 * Used by admin to preview what the final PDF will look like before
 * hitting Issue.
 */
import { err, ok, type Result } from '@/lib/result';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { ClockPort } from '../ports/clock-port';
import type { AuditPort } from '../ports/audit-port';
import { loadTenantLogo } from '../lib/load-tenant-logo';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import { asInvoiceId, type InvoiceId } from '@/modules/invoicing/domain/invoice';

export interface PreviewInvoiceDraftInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /**
   * R7-W1 — actor context for cross-tenant probe audit. Supplied by
   * the admin route; internal sweepers / tests may omit.
   */
  readonly actorUserId?: string;
  readonly requestId?: string | null;
}

export type PreviewInvoiceDraftError =
  | { code: 'invoice_not_found' }
  | { code: 'not_draft' }
  | { code: 'settings_missing' }
  | { code: 'member_not_found' };

export interface PreviewInvoiceDraftDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly memberIdentity: MemberIdentityPort;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly clock: ClockPort;
  readonly currentTemplateVersion: number;
  /**
   * R7-W1 — optional because draft preview is a read-through that
   * can legitimately run without actor context (tests, sweepers).
   * Probe audit fires only when BOTH `audit` dep AND `actorUserId`
   * input are supplied.
   */
  readonly audit?: AuditPort;
}

export async function previewInvoiceDraft(
  deps: PreviewInvoiceDraftDeps,
  input: PreviewInvoiceDraftInput,
): Promise<Result<{ bytes: Uint8Array; contentType: 'application/pdf' }, PreviewInvoiceDraftError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  return deps.invoiceRepo.withTx(async (tx) => {
    const draft = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
    if (!draft) {
      // R7-W1 — probe on not-found when actor context is provided.
      if (deps.audit && input.actorUserId) {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_cross_tenant_probe',
          actorUserId: input.actorUserId,
          summary: `Probe on invoice ${invoiceId} (not found on preview)`,
          payload: {
            attempted_invoice_id: invoiceId,
            actor_role: 'admin',
            route: 'preview-invoice-draft',
          },
        });
      }
      return err({ code: 'invoice_not_found' });
    }
    if (draft.status !== 'draft') return err({ code: 'not_draft' });

    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'settings_missing' });

    const member = await deps.memberIdentity.getForIssue(tx, input.tenantId, draft.memberId);
    if (!member) return err({ code: 'member_not_found' });

    // Pricing
    let subtotal = Money.zero();
    for (const line of draft.lines) subtotal = subtotal.add(line.total);
    const { vat, total } = calculateVat(subtotal, settings.vatRate);

    const tenantLogo = await loadTenantLogo(deps.blob, settings.identity.logo_blob_key);
    const rendered = await deps.pdfRender.render({
      kind: 'invoice_preview',
      templateVersion: deps.currentTemplateVersion,
      documentNumber: null,
      issueDate: null,
      dueDate: null,
      tenant: settings.identity,
      tenantLogo,
      member: member.snapshot,
      lines: draft.lines,
      subtotal,
      vatRate: settings.vatRate,
      vat,
      total,
    });

    return ok({ bytes: rendered.bytes, contentType: 'application/pdf' });
  });
}
