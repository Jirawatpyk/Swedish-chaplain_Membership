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
  | 'invoice_voided' // TODO T100: also add to F4MemberTimelineAuditEventType below when emit ships (US5 / Phase 9)
  | 'invoice_overdue_detected'
  | 'credit_note_issued'
  | 'tenant_invoice_settings_updated'
  | 'invoice_pdf_resent' // TODO T107: also add to F4MemberTimelineAuditEventType below when emit ships (Phase 10)
  | 'receipt_pdf_resent'
  | 'credit_note_pdf_resent'
  | 'invoice_pdf_regenerated'
  | 'invoice_cross_tenant_probe'
  | 'credit_note_cross_tenant_probe'
  | 'pdf_render_failed'
  | 'auto_email_delivery_failed';

/**
 * F4 event types that MUST appear in the F3 member timeline
 * (`payload->>'member_id'` query) AND have an implemented emit site.
 * The discriminated-union payload contract below forces compile-time
 * `member_id` presence on every emit site so a new member-surfaceable
 * event type cannot silently omit the field.
 *
 * This union is DELIBERATELY narrower than `F4_MEMBER_TIMELINE_EVENT_TYPES`
 * in the invoicing barrel — types without an implemented emit site
 * (today: `invoice_voided` Phase 9 / T105, `invoice_pdf_resent`
 * Phase 10 / T107) are excluded until the emit ships, otherwise the
 * compile-time guarantee is inert for those types. The runtime array
 * in the barrel keeps them declared so the copy-resolver is ready
 * on day one when the emit lands.
 *
 * `invoice_cross_tenant_probe` / `credit_note_cross_tenant_probe` are
 * intentionally NOT in this union — probes fire BEFORE the member is
 * validated, so `member_id` is not available at emit time. If a future
 * use-case can supply `attempted_member_id`, promote the probe type
 * into a dedicated probe-timeline variant rather than relaxing this
 * one.
 */
export type F4MemberTimelineAuditEventType =
  | 'invoice_draft_created'
  | 'invoice_issued'
  | 'invoice_paid'
  | 'credit_note_issued';

/** Payload contract for events that surface in the F3 member timeline. */
export type MemberTimelineAuditPayload = {
  readonly member_id: string;
} & Record<string, unknown>;

export type F4AuditEvent =
  | {
      readonly eventType: F4MemberTimelineAuditEventType;
      readonly actorUserId: string;
      readonly summary: string;
      readonly payload: MemberTimelineAuditPayload;
    }
  | {
      readonly eventType: Exclude<F4AuditEventType, F4MemberTimelineAuditEventType>;
      readonly actorUserId: string;
      readonly summary: string;
      readonly payload: Record<string, unknown>;
    };

/**
 * Emit an audit row.
 *
 * `tx` semantics:
 *   - **Mutation path** (e.g., `issueInvoice`, `recordPayment`): MUST
 *     pass the Drizzle transaction handle. The audit row lands inside
 *     the same transaction as the mutation — either both commit or
 *     both roll back (Constitution Principle I clause 3 atomicity).
 *   - **Read-path probe** (e.g., cross-tenant-probe emitted by
 *     `getInvoice` / `getInvoicePdfSignedUrl` / `listInvoices`): pass
 *     `null`. The use case has no open transaction (read-only) so
 *     the audit row writes on an auto-commit connection. Probe audit
 *     failure is logged by the adapter but does NOT fail the read
 *     (probe logging is best-effort — losing a probe row is less bad
 *     than a legitimate read returning 500).
 *
 * Adapters MUST handle both cases. See `f4AuditAdapter` for the
 * canonical implementation.
 */
export interface AuditPort {
  emit(tx: unknown, event: F4AuditEvent & { tenantId: string; requestId: string | null }): Promise<void>;
}
