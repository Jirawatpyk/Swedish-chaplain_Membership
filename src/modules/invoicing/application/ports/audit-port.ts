/**
 * T032 — Audit port (F4).
 *
 * 16 F4 audit event types defined here as a discriminated union so
 * callers cannot pass an unknown event_type. Payload shapes are
 * structurally typed per data-model.md § 4.
 */

export type F4AuditEventType =
  | 'invoice_draft_created'
  | 'invoice_draft_updated'
  | 'invoice_draft_deleted'
  | 'invoice_issued'
  | 'invoice_paid'
  | 'invoice_voided'
  | 'invoice_overdue_detected'
  | 'credit_note_issued'
  | 'tenant_invoice_settings_updated'
  | 'invoice_pdf_resent'
  | 'receipt_pdf_resent'
  | 'credit_note_pdf_resent'
  | 'invoice_cross_tenant_probe'
  | 'credit_note_cross_tenant_probe'
  | 'pdf_render_failed'
  | 'auto_email_delivery_failed';

export interface F4AuditEvent {
  readonly eventType: F4AuditEventType;
  readonly actorUserId: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Emit an audit row. MUST be called inside the same transaction as the
 * mutation being audited — the repo layer accepts a tx reference so
 * transactional writes land together.
 */
export interface AuditPort {
  emit(tx: unknown, event: F4AuditEvent & { tenantId: string; requestId: string | null }): Promise<void>;
}
