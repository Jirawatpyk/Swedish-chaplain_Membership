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
  | 'tenant_invoice_settings_cross_tenant_probe'
  /**
   * 054-event-fee-invoices (Task 6b) — emitted by `createEventInvoiceDraft`
   * when `EventRegistrationLookupPort.findById` returns `ok(null)`: the F6
   * registration either genuinely does not exist OR is RLS-hidden because it
   * belongs to another tenant. Indistinguishable at the data layer, so we
   * audit either case as a probe (Constitution Principle I clause 4). NON-
   * timeline (no `member_id` available — the read fires BEFORE the buyer is
   * resolved). Operational/probe class → 5y retention. Payload carries the
   * attempted `event_registration_id` + route.
   */
  | 'registration_cross_tenant_probe'
  | 'pdf_render_failed'
  | 'auto_email_delivery_failed'
  /**
   * T166-08 — emitted by the async render-receipt-pdf worker once
   * blob bytes land + status flips to `'rendered'`. Carries the
   * sha256 (audit retention 10y per tax-doc invariant). Distinct
   * from `invoice_paid` (which fires inside the webhook tx with
   * sha256=null on the async path) so reviewers can correlate the
   * paid event with the eventually-consistent render result.
   */
  | 'receipt_rendered'
  /**
   * T166-11 — emitted by the reconciliation cron when a render row
   * exhausts its retry budget (3 attempts). Pages on-call per
   * `docs/runbooks/receipt-pdf-permanently-failed.md`.
   */
  | 'pdf_render_permanently_failed'
  /**
   * Emitted by `getReceiptPdfSignedUrl` after a successful ownership
   * check + signed-URL issuance. Tax-document touch (the bytes belong
   * to a Thai-RD-compliant tax receipt) so retention bucket is 10y
   * mirroring `receipt_rendered` + `receipt_pdf_resent`. Payload
   * carries `receipt_document_number_raw` (null for combined-mode
   * where receipt PDF = invoice PDF) + `actor_role`.
   */
  | 'receipt_pdf_downloaded'
  /**
   * Emitted by `updateTenantInvoiceSettings` when an admin flips any
   * §87 document-number prefix (invoice / credit-note / receipt) on
   * an already-active tenant. Thai RD §87 verifies continuity by full
   * document number (prefix + year + seq); a prefix flip mid-year
   * looks like a sequence gap from the outside even though the seq
   * counter is intact. Forensic trail captures: old/new prefix per
   * type, last seq used under each old prefix, fiscal year. 10y
   * retention — surface in forensic SELECT on a future RD audit.
   */
  | 'tenant_receipt_prefix_changed'
  /**
   * R8-M1-code — emitted by `getInvoicePdfSignedUrl` after a successful
   * ownership check + signed-URL issuance. Closes the audit-coverage
   * asymmetry where receipts logged downloads but invoices did not.
   * Tax-document touch (invoice PDF is the §86/4 tax document) so
   * retention is 10y, parity with `invoice_pdf_resent` + receipt
   * peers. Payload: `invoice_id`, `member_id`, `actor_member_id`
   * (null for non-member actors), `invoice_pdf_template_version`,
   * `actor_role`, `route`. The member_id makes the event surface in
   * the F3 timeline filter; actor_member_id enables a JOIN to the
   * members table without re-resolving the actor.
   */
  | 'invoice_pdf_downloaded'
  /**
   * Phase 3 of the F4 receipt-surface plan — emitted by
   * `exportPaidInvoicesCsv` after a successful CSV stream generation
   * (Thai VAT monthly-filing workflow). Operational/audit class →
   * 5y retention (Constitution VIII). NOT a tax-document touch
   * itself: the CSV is a derivative report; the underlying
   * invoice/receipt rows already carry their own 10y events.
   * Payload: `from`, `to`, `row_count`, `actor_user_id`, `route`.
   */
  | 'invoices_csv_exported';

/**
 * Retention-year mapping for F4 audit events (data-model 009 § 7.2).
 *
 * 10y: tax-document-touching events — Thai RD §87/3 + §86/10 statutory
 *      minimum. F9 GDPR purge MUST NOT delete before this window.
 *  5y: operational / probe / config events — Constitution Principle VIII
 *      financial-record retention.
 *
 * **Critical**: this map mirrors `drizzle/migrations/0039_audit_log_add_retention_years.sql`
 * § 3 backfill UPDATE for go-forward writes. Migration backfill only runs
 * once at apply time; new rows after that get DEFAULT 5 unless the emitter
 * sets the column explicitly. Without this mapping the F4 audit emitter
 * silently downgrades tax-document audit retention — caught by T135
 * (`audit-retention-backfill.test.ts`).
 */
export const F4_AUDIT_RETENTION_YEARS: Record<F4AuditEventType, 5 | 10> = {
  invoice_draft_created: 5,
  invoice_draft_updated: 5,
  invoice_draft_deleted: 5,
  invoice_issued: 10,
  invoice_paid: 10,
  invoice_voided: 10,
  invoice_overdue_detected: 5,
  credit_note_issued: 10,
  tenant_invoice_settings_updated: 5,
  invoice_pdf_resent: 10,
  receipt_pdf_resent: 10,
  credit_note_pdf_resent: 10,
  invoice_pdf_regenerated: 10,
  invoice_cross_tenant_probe: 5,
  credit_note_cross_tenant_probe: 5,
  tenant_invoice_settings_cross_tenant_probe: 5,
  // 054-event-fee-invoices — probe/operational event; 5y (no tax-doc touch).
  registration_cross_tenant_probe: 5,
  pdf_render_failed: 5,
  auto_email_delivery_failed: 5,
  // T166: tax-doc-touching (receipt sha256 lands on this row); 10y.
  receipt_rendered: 10,
  // T166: ops/reliability event; 5y.
  pdf_render_permanently_failed: 5,
  // Tax-document touch (receipt PDF bytes accessed); 10y per Thai RD §87/3.
  receipt_pdf_downloaded: 10,
  // §87 forensic trail — surface on RD audit; 10y to match other
  // tax-document audit events.
  tenant_receipt_prefix_changed: 10,
  // R8-M1-code — tax-document touch (invoice PDF bytes accessed); 10y
  // per Thai RD §86/4 + §87/3, parity with peers.
  invoice_pdf_downloaded: 10,
  // Phase 3 — derivative export, not a §86/§87 tax document; 5y
  // operational retention per Constitution VIII.
  invoices_csv_exported: 5,
};

/** Single-source helper — call at every F4 emit site. */
export function f4RetentionFor(eventType: F4AuditEventType): 5 | 10 {
  return F4_AUDIT_RETENTION_YEARS[eventType];
}

/**
 * F4 event types that MUST appear in the F3 member timeline
 * (`payload->>'member_id'` query) AND have an implemented emit site.
 * The discriminated-union payload contract below forces compile-time
 * `member_id` presence on every emit site so a new member-surfaceable
 * event type cannot silently omit the field.
 *
 * `invoice_voided` was promoted into this union in Phase 9 / T100 —
 * the void-invoice use-case emit carries `member_id: invoice.memberId`
 * so the F3 member timeline filter (`payload->>'member_id'`) picks up
 * voids automatically.
 *
 * `invoice_pdf_resent` was promoted in Phase 10 / T107 — the manual
 * resend-pdf use-case emit carries `member_id: invoice.memberId`
 * so a member's F3 timeline surfaces every time an admin (or the
 * member themself via portal) triggered a fresh invoice email.
 * `receipt_pdf_resent` + `credit_note_pdf_resent` stay out by design
 * (duplicates of `invoice_paid` / `credit_note_issued`).
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
  | 'invoice_voided'
  | 'invoice_pdf_resent'
  | 'credit_note_issued';

/**
 * The set of F4 audit event types that do NOT require `member_id` in their
 * payload. Naming this type explicitly avoids the misleading pattern
 * `'invoice_issued' as Exclude<F4AuditEventType, F4MemberTimelineAuditEventType>`
 * at NON-MEMBER emit sites — `Exclude<…>` resolves to a union that does NOT
 * include `invoice_issued`, so the plain `as` bypasses the payload contract
 * silently. Callers that intentionally emit a timeline-typed event through the
 * non-timeline branch (no member_id, non-member event buyer) must cast via
 * `as unknown as F4NonTimelineEventType` to make the deliberate bypass visible.
 */
export type F4NonTimelineEventType = Exclude<F4AuditEventType, F4MemberTimelineAuditEventType>;

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
 *     the audit row writes on an auto-commit connection via the
 *     OWNER role (BYPASSRLS) — tenantId is supplied explicitly in
 *     the INSERT so cross-tenant isolation is preserved by data not
 *     by role.
 *
 * Round-3 contract correction: the previous docstring claimed probe
 * failures are "best-effort logged but don't fail the read". The
 * adapter does NOT wrap the INSERT in a try/catch — probe failures
 * DO propagate to the caller. Route layers wrap the use-case call
 * (per H-7 fix Round-2) so a probe-emit throw surfaces as a
 * structured 500. If a future use-case needs swallow-on-emit
 * semantics it must add its own try/catch around `audit.emit(null,
 * ...)`; the adapter contract is "INSERT or throw".
 *
 * Adapters MUST handle both cases. See `f4AuditAdapter` for the
 * canonical implementation.
 */
export interface AuditPort {
  emit(tx: unknown, event: F4AuditEvent & { tenantId: string; requestId: string | null }): Promise<void>;
}
