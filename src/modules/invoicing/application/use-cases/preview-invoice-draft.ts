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
import type { ClockPort } from '../ports/clock-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import { asInvoiceId, type InvoiceId } from '@/modules/invoicing/domain/invoice';

export interface PreviewInvoiceDraftInput {
  readonly tenantId: string;
  readonly invoiceId: string;
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
  readonly clock: ClockPort;
  readonly currentTemplateVersion: number;
}

export async function previewInvoiceDraft(
  deps: PreviewInvoiceDraftDeps,
  input: PreviewInvoiceDraftInput,
): Promise<Result<{ bytes: Uint8Array; contentType: 'application/pdf' }, PreviewInvoiceDraftError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  return deps.invoiceRepo.withTx(async (tx) => {
    const draft = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    if (!draft) return err({ code: 'invoice_not_found' });
    if (draft.status !== 'draft') return err({ code: 'not_draft' });

    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'settings_missing' });

    const member = await deps.memberIdentity.getForIssue(tx, input.tenantId, draft.memberId);
    if (!member) return err({ code: 'member_not_found' });

    // Pricing
    let subtotal = Money.zero();
    for (const line of draft.lines) subtotal = subtotal.add(line.total);
    const { vat, total } = calculateVat(subtotal, settings.vatRate);

    const rendered = await deps.pdfRender.render({
      kind: 'invoice_preview',
      templateVersion: deps.currentTemplateVersion,
      documentNumber: null,
      issueDate: null,
      dueDate: null,
      tenant: settings.identity,
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
