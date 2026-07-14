/**
 * T032 — Audit port (F4).
 *
 * The F4 audit event types are defined here as a discriminated union so
 * callers cannot pass an unknown event_type. (The authoritative count is
 * `F4_AUDIT_RETENTION_YEARS` below — every union member must have a retention
 * entry — so no hard count is kept in this header to rot.) Payload shapes are
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
  | 'invoices_csv_exported'
  /**
   * 054-event-fee-invoices (Task 15) — emitted by the
   * `/api/cron/invoicing/redact-expired-event-buyers` retention sweeper
   * once a non-member EVENT-fee invoice issued >10 years ago has its
   * buyer PII tombstoned in `member_identity_snapshot` (Thai RD §87/3 +
   * §86/10 statutory retention satisfied → GDPR Art. 5(1)(e) /
   * Art. 17 minimisation requires erasure). NON-timeline (the row has
   * `member_id IS NULL` — there is no member to surface on the F3
   * timeline). The payload carries `invoice_id`, `redacted_at`, and the
   * list of `redacted_fields` (field NAMES only, NEVER the PII values)
   * so a future RD/forensic SELECT can prove WHICH columns were erased
   * WHEN, without re-introducing the erased PII into the audit trail.
   * 10-year retention so the §87/3 forensic window still covers the
   * erasure record itself (the financial/numbering fields on the
   * invoice row are PRESERVED untouched — only the buyer identity is
   * tombstoned).
   *
   * COMP-1 US3-B — this type is now ALSO emitted by the sibling
   * `/api/cron/invoicing/redact-expired-member-invoices` sweeper for an
   * ERASED member's >10y documents (membership invoices, matched-member
   * EVENT invoices, AND credit notes). Those payloads ADD a discriminator:
   * `member_id` (the erased member — a uuid; the PII was scrubbed) +
   * `document_kind` (`'invoice'` | `'credit_note'`) + (`invoice_subject`
   * for invoices / `original_invoice_id` for credit notes), so the DPO
   * erasure-evidence log (US3-D) can join the tax-redaction outcome per
   * member. The event-named type is LEGACY (it predates the member arm);
   * the `document_kind`/`member_id` discriminator makes the member case
   * unambiguous. At the TS level it stays on the generic (non-timeline) arm
   * of `F4AuditEvent`, BUT at RUNTIME the F9 `member_timeline_v` selects audit
   * rows purely by `payload ? 'member_id'` (no event-type allow-list), so the
   * MEMBER-arm row (which carries `member_id`) DOES surface on that erased
   * member's timeline — an INTENDED record-of-processing entry (the erasure
   * lifecycle, consistent with US3-A post-erase state S5 + the US3-D DPO
   * evidence log, which needs `member_id` to join). The legacy non-member arm
   * (member_id absent) stays off the timeline. No new audit type was added.
   */
  | 'event_buyer_pii_redacted'
  /**
   * 088-invoice-tax-flow-redesign (§ F.6, migration 0230) — the §86/4 tax
   * receipt FIRST-ISSUANCE signal (SC-001). Emitted IN-TX with the §87 `RC`
   * receipt-number allocation at the payment moment on BOTH the offline
   * (`record-payment.ts`) and event as-paid (`issue-event-invoice-as-paid.ts`)
   * paths — and therefore on the online passthrough that funnels through
   * `recordPayment`. DISTINCT from `invoice_paid`: it marks the moment a §86/4
   * tax receipt (RC §87 number) comes into existence, not the payment itself.
   * The subsequent async `render-receipt-pdf` worker does NOT re-fire it (the
   * event marks allocation, not render). 10y retention (Thai RD §87/3
   * tax-document class), same posture as `invoice_paid` / the F4 backfill.
   */
  | 'tax_receipt_issued'
  /**
   * 059 PR-A Task 4 fix (thai-tax-compliance-auditor HIGH finding) — the
   * Domain VO's write-time invariant (member-identity-snapshot.ts ~175-189)
   * fired: the buyer resolved at issue is a VAT registrant
   * (`buyer_is_vat_registrant=true`) with no `tax_id` (ประกาศอธิบดีฯ 196 +
   * 199 are a pair). `makeMemberIdentitySnapshot` THROWS
   * `InvalidMemberIdentitySnapshotError` (not a Result) — previously this
   * escaped both `issueInvoice` and `issueEventInvoiceAsPaid`'s catch
   * (neither tested for it) and surfaced as an unhandled 500 with ZERO audit
   * trail. Emitted from the outer catch AFTER rollback (tx already dead,
   * same posture as `pdf_render_failed`) — the throw lands PRE-SEQUENCE
   * (buyer resolution runs before `allocateNext`), so no §87 number is ever
   * burned by this reject. NOT a tax-document touch (nothing was issued) →
   * 5y operational/reject retention, same class as `pdf_render_failed` /
   * `registration_cross_tenant_probe`. Payload carries `invoice_id` + the
   * raw zod issue paths/messages (no PII — the VO's messages never echo the
   * buyer's actual data). `invoice_` prefix deliberately chosen so this
   * lands in the `invoice_` bucket of both the F4 enum↔retention parity
   * test (`prefixes` list) and the admin audit-viewer's category heuristic
   * (`auditEventCategory`) with zero extra allow-list entries.
   */
  | 'invoice_buyer_identity_invalid';

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
  // 054-event-fee-invoices (Task 15) — erasure record for a non-member
  // event-invoice buyer's PII. The underlying invoice is a §86/4 tax
  // document, so the erasure event itself keeps the 10y forensic window
  // (the RD must be able to see WHICH columns were minimised WHEN).
  event_buyer_pii_redacted: 10,
  // 088-invoice-tax-flow-redesign (§ F.6) — §86/4 tax-receipt first-issuance
  // signal. Tax-document class (Thai RD §87/3) → 10y.
  tax_receipt_issued: 10,
  // 059 PR-A Task 4 fix — write-time buyer-identity-snapshot invariant reject
  // at issue (VAT registrant, no tax_id). No tax document was produced (the
  // reject is PRE-SEQUENCE — no §87 number burned) → 5y operational/reject
  // retention, same class as pdf_render_failed.
  invoice_buyer_identity_invalid: 5,
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

/** Payload contract for events that surface in the F3 member timeline. */
export type MemberTimelineAuditPayload = {
  readonly member_id: string;
} & Record<string, unknown>;

/**
 * 054-event-fee-invoices — payload contract for a member-timeline event type
 * (`F4MemberTimelineAuditEventType`) emitted for a NON-member EVENT buyer.
 *
 * A non-member event invoice has `member_id IS NULL` — there is no F3 member to
 * surface on the member timeline. The F3 timeline filter keys on
 * `payload->>'member_id'`, so the audit row MUST omit `member_id` entirely; the
 * non-member buyer is correlated by the F6 `event_registration_id` instead.
 *
 * `member_id?: never` makes the key COMPILE-TIME FORBIDDEN: a payload that
 * accidentally carries `member_id` (e.g. the old `invoice.memberId ?? ''`
 * coalesce that produced `member_id: ''`) fails typecheck rather than
 * persisting a structurally-invalid timeline row. `event_registration_id` is
 * REQUIRED so the non-member branch always carries the F6 correlation key. This
 * replaces the `as unknown as Exclude<F4AuditEventType,
 * F4MemberTimelineAuditEventType>` double-cast that defeated ALL payload
 * type-checking at the 5 non-member emit sites.
 */
export type NonMemberInvoiceAuditPayload = {
  readonly event_registration_id: string;
  readonly member_id?: never;
} & Record<string, unknown>;

export type F4AuditEvent =
  | {
      readonly eventType: F4MemberTimelineAuditEventType;
      readonly actorUserId: string;
      readonly summary: string;
      readonly payload: MemberTimelineAuditPayload;
    }
  | {
      /**
       * Non-member EVENT-buyer variant of a member-timeline event type. Same
       * `eventType` set as the timeline arm above, but the payload omits
       * `member_id` (FORBIDDEN via `member_id?: never`) and requires
       * `event_registration_id`. TypeScript routes an object literal to THIS
       * arm iff it carries `event_registration_id` and NO `member_id` — so the
       * two arms stay unambiguous without any cast. Emit via
       * `emitNonMemberInvoiceEvent`.
       */
      readonly eventType: F4MemberTimelineAuditEventType;
      readonly actorUserId: string;
      readonly summary: string;
      readonly payload: NonMemberInvoiceAuditPayload;
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

/**
 * 054-event-fee-invoices — TYPED emit helper for a member-timeline event type
 * fired for a NON-member EVENT buyer (no F3 member id).
 *
 * The 5 non-member emit sites (`create-event-invoice-draft` /
 * `issue-invoice` / `record-payment` / `issue-credit-note` / `resend-pdf`)
 * previously cast a timeline event-type `as unknown as Exclude<F4AuditEventType,
 * F4MemberTimelineAuditEventType>` with an `event_registration_id` payload. The
 * double-cast defeated ALL payload type-checking and was duplicated (with ~20
 * lines of rationale) at each site.
 *
 * This helper is the single typed escape: it accepts a `NonMemberInvoiceAuditPayload`
 * (`event_registration_id` REQUIRED, `member_id` FORBIDDEN) and routes it to
 * the dedicated non-member arm of `F4AuditEvent` — ZERO `as` casts. The
 * compiler enforces:
 *   - `eventType` is a member-timeline event type (`F4MemberTimelineAuditEventType`);
 *   - the payload carries `event_registration_id`;
 *   - the payload does NOT carry `member_id` (the F3-timeline key is omitted so
 *     the non-member row never surfaces on a member timeline, and the
 *     `members.last_activity_at` trigger never casts an empty `member_id` ::uuid).
 *
 * `tx` follows the same convention as `AuditPort.emit`: pass the Drizzle tx for
 * mutation-path emits (atomic with the mutation); pass `null` for read-path
 * emits (e.g. resend-pdf, which is append-only against mutations).
 */
export function emitNonMemberInvoiceEvent(
  audit: AuditPort,
  tx: unknown,
  event: {
    readonly tenantId: string;
    readonly requestId: string | null;
    readonly eventType: F4MemberTimelineAuditEventType;
    readonly eventRegistrationId: string;
    readonly actorUserId: string;
    readonly summary: string;
    /**
     * Extra payload fields. `member_id` is FORBIDDEN here (`member_id?: never`)
     * so a caller cannot smuggle it back in through the spread; the F3-timeline
     * key stays absent on the persisted row. `event_registration_id` is
     * supplied via the typed `eventRegistrationId` arg and merged below, so it
     * does not need to be repeated here.
     */
    readonly extraPayload?: { readonly member_id?: never } & Record<string, unknown>;
  },
): Promise<void> {
  const payload: NonMemberInvoiceAuditPayload = {
    ...event.extraPayload,
    event_registration_id: event.eventRegistrationId,
  };
  return audit.emit(tx, {
    tenantId: event.tenantId,
    requestId: event.requestId,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    summary: event.summary,
    payload,
  });
}
