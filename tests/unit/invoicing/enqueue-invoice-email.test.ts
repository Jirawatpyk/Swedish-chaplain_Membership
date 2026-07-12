/**
 * Cluster 5 (Finding 1) — unit tests for `enqueueInvoiceAutoEmail`.
 *
 * The shared issuance auto-email helper (used by `issueInvoice` and
 * `issueEventInvoiceAsPaid`) now returns a discriminated dispatch outcome so
 * the otherwise-SILENT "buyer has no contact email" skip becomes observable to
 * the caller (→ the API route → the admin toast). This test pins:
 *   - a present recipient enqueues one outbox row and returns 'sent';
 *   - an empty / null recipient enqueues NOTHING and returns 'skipped_no_email'
 *     (the case an imported member with no email on file hits).
 *
 * Pure — the only collaborator is a stub `EmailOutboxPort`.
 */
import { describe, expect, it, vi } from 'vitest';
import { enqueueInvoiceAutoEmail } from '@/modules/invoicing/application/lib/enqueue-invoice-email';
import type { EmailOutboxPort } from '@/modules/invoicing/application/ports/email-outbox-port';
import type { InvoiceId } from '@/modules/invoicing/domain/invoice';

function makeOutbox(): { outbox: EmailOutboxPort; enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn(async () => {});
  return { outbox: { enqueue } as unknown as EmailOutboxPort, enqueue };
}

const baseArgs = {
  tenantId: 'tenantA',
  invoiceId: 'inv-1' as InvoiceId,
  invoiceSubject: 'membership' as const,
  eventType: 'invoice_issued' as const,
  pdfBlobKey: 'invoicing/tenantA/2026/inv-1.pdf',
  pdfTemplateVersion: 1,
  skipLogMessage: 'test: auto-email skipped — buyer has no contact email',
};

describe('enqueueInvoiceAutoEmail — dispatch outcome (Cluster 5 Finding 1)', () => {
  it("returns 'sent' and enqueues one row when a recipient is present", async () => {
    const { outbox, enqueue } = makeOutbox();
    const outcome = await enqueueInvoiceAutoEmail(outbox, {}, {
      ...baseArgs,
      recipientEmail: 'buyer@example.com',
    });
    expect(outcome).toBe('sent');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("returns 'skipped_no_email' and enqueues NOTHING when the recipient is null", async () => {
    const { outbox, enqueue } = makeOutbox();
    const outcome = await enqueueInvoiceAutoEmail(outbox, {}, {
      ...baseArgs,
      recipientEmail: null,
    });
    expect(outcome).toBe('skipped_no_email');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only recipient as absent → 'skipped_no_email'", async () => {
    const { outbox, enqueue } = makeOutbox();
    const outcome = await enqueueInvoiceAutoEmail(outbox, {}, {
      ...baseArgs,
      recipientEmail: '   ',
    });
    expect(outcome).toBe('skipped_no_email');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
