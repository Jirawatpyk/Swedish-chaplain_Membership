/**
 * T032 — Audit port (F4).
 *
 * 17 F4 audit event types defined here as a discriminated union so
 * callers cannot pass an unknown event_type. Payload shapes are
 * structurally typed per data-model.md § 4.
 *
 * `invoice_pdf_regenerated` (added 2026-04-20 as part of SC-003 /
 * CP-5.2 Best Practice closure): emitted by the auto-rerender path
 * (R3-E4) when a Blob outage forces re-render of a previously-issued
 * invoice. Payload includes original sha256 + new sha256 + reason so
 * forensic / compliance review can determine whether the regenerated
 * bytes are user-equivalent (text content + structure unchanged) vs.
 * structurally divergent (template bug).
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
  | 'invoice_pdf_regenerated'
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
