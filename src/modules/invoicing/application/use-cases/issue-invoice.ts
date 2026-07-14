/**
 * T037 — issue-invoice use case (F4).
 *
 * THE critical transactional path per plan § VIII Reliability.
 *
 * Canonical lock order (documented below so reviewers can spot-check):
 *   1. invoice row FOR UPDATE (lockForUpdate — serialises concurrent issues)
 *   2. member FOR UPDATE (archive-race guard FR-037)
 *      — SKIPPED for non-member event invoices (buyer snapshot pinned at
 *        draft; there is no F3 member row to lock)
 *   3. pg_advisory_xact_lock('invoicing:{tenant}:{doc_type}:{fy}')
 *   4. tenant_document_sequences FOR UPDATE (inside allocator)
 *
 * R7-S1 — deadlock-safety rationale:
 *   The (invoice → member → advisory → seq) order is currently
 *   DEADLOCK-FREE against the F3 `archive-member` path. Archive-
 *   member acquires ONLY the member lock (no invoice lock), so:
 *     issue-invoice holds invoice, waits for member
 *     archive-member holds member, does NOT wait for invoice
 *   The waits-for graph has no cycle → no deadlock possible.
 *
 *   IF a future refactor gives archive-member an invoice lock (e.g.
 *   to prevent issuing against a mid-archive member atomically),
 *   this ordering flips to deadlock-prone. At that point REVERSE to
 *   (member → invoice → advisory → seq) — archive-member's single
 *   member-lock acquisition stays compatible, and the waits-for
 *   graph remains acyclic.
 *
 *   Until then, do NOT add an invoice lock to archive-member without
 *   flipping this use-case's lock order FIRST.
 *
 * Operations (all inside a single DB transaction):
 *   A. load tenant settings (no lock; read-only snapshot)
 *   B. load + lock invoice draft
 *   C. load + lock member (archive-race guard — SKIPPED for non-member
 *      event invoices; buyer snapshot was pinned at draft)
 *   D. compute fiscal year (Bangkok TZ)
 *   E. allocate sequence number
 *   F. compute subtotal + VAT + total from DRAFT lines
 *   G. build tenant + member identity snapshots
 *   H. render PDF (deterministic)
 *   I. upload PDF to Blob (content-addressed)
 *   J. applyIssue UPDATE on invoices row
 *   K. emit `invoice_issued` audit
 *   L. enqueue auto-email outbox row if auto_email_on_issue resolves true
 *   M. COMMIT
 *
 * Any throw in A-L rolls back the whole tx — seq is NOT consumed; the
 * Blob upload may leave an orphan at the deterministic content-addressed
 * key (tenant+id+template). No sweeper exists (accepted residual, 064
 * design §3.2 L-1), but this use-case carries its OWN best-effort
 * catch-path delete of that key (065 L-3, ported from
 * issueEventInvoiceAsPaid — see the outer catch below); the as-paid path
 * does the same. The delete is best-effort: a failure is logged + counted
 * and never masks the original error, so a swept-later orphan remains the
 * accepted worst case.
 *
 * RBAC: admin only (route handler guard).
 * Rate limit: 20 / 5min per (tenant, actor) — applied at route level.
 * Idempotency: if `Idempotency-Key` header was handled at route, this
 * function is safe to call again with the same invoiceId → it detects
 * already-issued and returns the persisted invoice (short-circuit).
 */
import { err, ok, type Result } from '@/lib/result';
import { asSatang } from '@/lib/money';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type { EventRegistrationLookupPort } from '../ports/event-registration-lookup-port';
import type { SequenceAllocatorPort } from '../ports/sequence-allocator-port';
import type { PdfDocKind, PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import { emitNonMemberInvoiceEvent, type AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { EmailOutboxPort } from '../ports/email-outbox-port';
import {
  asInvoiceId,
  enforceOneSubjectLine,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { fiscalYearFromUtcIso } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import {
  resolveVatRate,
  type VatTreatment,
} from '@/modules/invoicing/domain/policies/vat-treatment';
import { splitVatInclusive } from '@/modules/invoicing/domain/value-objects/vat-inclusive';
import {
  inferEventDocumentKind,
  resolveBuyerIsVatRegistrant,
} from '@/modules/invoicing/domain/document-kind';
import type { TaxAtPaymentFlag } from '@/modules/invoicing/domain/tax-at-payment-flag';
import {
  InvalidMemberIdentitySnapshotError,
  type MemberIdentitySnapshot,
} from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { bangkokLocalDate, addDays, isValidCalendarDate } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { renderAndUploadPdf } from '../lib/render-and-upload';
import { loadTenantLogo } from '../lib/load-tenant-logo';
import { resolveInvoiceBuyerForIssue } from '../lib/resolve-invoice-buyer';
import { enqueueInvoiceAutoEmail } from '../lib/enqueue-invoice-email';
import type { EmailDispatchOutcome } from '../email-dispatch-outcome';

export const issueInvoiceSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  // 088 US8 (§ F.8 / FR-023..025) — per-invoice VAT treatment + MFA certificate.
  // `vatTreatment` defaults to 'standard' (VAT 7%); `'zero_rated_80_1_5'` is the
  // embassy / int'l-org §80/1(5) zero rate. The cert fields are supporting
  // evidence — `zeroRateCertNo` is the FAIL-CLOSED gate (checked in-use-case,
  // 422 `zero_rate_cert_required`), the scan (`zeroRateCertBlobKey`) is optional.
  // `.optional()` WITHOUT `.default()` keeps `IssueInvoiceInput.vatTreatment`
  // optional so existing direct callers need not pass it; the use-case applies
  // the `?? 'standard'` default.
  vatTreatment: z.enum(['standard', 'zero_rated_80_1_5']).optional(),
  zeroRateCertNo: z.string().max(200).optional(),
  // Shape regex first, then real-calendar refine — the regex alone accepts
  // impossible dates (2026-02-30) that then persist into the Postgres `date`
  // column → DB rejects → unhandled 500. The refine rejects at parse (typed
  // 4xx). `.optional()` last so an omitted cert date still bypasses the string
  // checks (undefined short-circuits before the refine runs).
  zeroRateCertDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidCalendarDate, { message: 'not a real calendar date' })
    .optional(),
  zeroRateCertBlobKey: z.string().max(1024).optional(),
});

export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;

export type IssueInvoiceError =
  | { code: 'invoice_not_found' }
  | { code: 'invoice_already_issued'; status: InvoiceStatus }
  | { code: 'settings_missing' }
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  /**
   * 054-event-fee-invoices — a NON-member event invoice reached issue without a
   * buyer snapshot pinned at draft. `createEventInvoiceDraft` always pins the
   * non-member buyer snapshot, so this is a data-integrity guard (corrupted /
   * hand-written draft) rather than a normal flow.
   */
  | { code: 'no_buyer_snapshot' }
  /**
   * 064 §105 ROOT FIX — an EVENT draft whose buyer has no TIN cannot be
   * billed first: their only legal document is a §105 receipt, which may
   * exist only at the moment payment is recorded (`issueEventInvoiceAsPaid`).
   */
  | { code: 'event_no_tin_requires_paid_issue' }
  /**
   * 064 S1 — the F6 registration was refunded AFTER the draft was created
   * (createEventInvoiceDraft only hard-blocks refunded at DRAFT time).
   * Billing it would assert a fee the buyer already got back — re-checked
   * in-tx at issuance, PRE-allocation (no §87 burn). Event subject only.
   */
  | { code: 'registration_refunded' }
  /**
   * 064 S1 — the issuance-time registration re-read failed (port err) or
   * returned null (row vanished / RLS anomaly). Refuse to issue a tax
   * document against a registration we can no longer verify.
   */
  | { code: 'registration_lookup_failed' }
  | { code: 'invalid_lines'; reason: string }
  /**
   * 088 US8 (FR-025) — a MEMBERSHIP subject supplied as `zero_rated_80_1_5` is
   * illegal (membership is ALWAYS VAT 7%). REJECTED (no invoice issued) — a
   * reject, NOT a silent coerce. Defense-in-depth behind the form hiding the
   * toggle for membership subjects. 422.
   */
  | { code: 'membership_cannot_be_zero_rated' }
  /**
   * 088 US8 (FR-024, fail-closed) — a `zero_rated_80_1_5` issue with a
   * missing/blank `zeroRateCertNo` is BLOCKED (no invoice issued). The DB
   * `invoices_zero_rate_cert_required` CHECK is defense-in-depth behind this. 422.
   */
  | { code: 'zero_rate_cert_required' }
  /**
   * 088 US8 UX-B1 review fix (SEC/reliability MED, CWE-639/CWE-20) — the OPTIONAL
   * cert-scan `zeroRateCertBlobKey` is client-supplied at issue, so it MUST be
   * re-validated to this tenant + this invoice's server-derived cert namespace
   * (`invoicing/<tenant>/zero-rate-certs/<invoiceId>_`). Rejects pinning an
   * arbitrary / never-ClamAV-scanned / cross-tenant blob onto the 10y-immutable
   * §86/4 tax document (Blob has no RLS → this is the isolation boundary,
   * Constitution I). 422.
   */
  | { code: 'zero_rate_cert_blob_key_invalid' }
  /**
   * 088 SEC-MED — a non-standard VAT treatment (`zero_rated_80_1_5`) was
   * forwarded while `FEATURE_088_TAX_AT_PAYMENT` is OFF. The §80/1(5) zero
   * rate is part of the tax-at-payment feature; the env.ts invariant is
   * "flag off → every invoice is standard 7%". The issue form hides the
   * toggle when the flag is dark, but a crafted request could still forward
   * it — so refuse server-side (no invoice issued, no §87 number burned,
   * cert fields not persisted). 422.
   */
  | { code: 'zero_rate_requires_flag' }
  | { code: 'overflow'; fiscalYear: FiscalYear }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string }
  /**
   * 059 PR-A Task 4 fix (thai-tax-compliance-auditor HIGH) — the buyer
   * resolved at issue is a VAT registrant with no `tax_id` (ประกาศอธิบดีฯ
   * 196 + 199 are a pair). Surfaced from the Domain VO's write-time
   * invariant (`InvalidMemberIdentitySnapshotError`,
   * member-identity-snapshot.ts) instead of an unhandled 500. PRE-SEQUENCE —
   * buyer resolution runs before `allocateNext`, so no §87 number is ever
   * burned by this reject. The admin fix is either field: add the tax ID,
   * or clear the VAT-registered checkbox if the number isn't known yet.
   */
  | { code: 'buyer_tax_id_required_for_registrant' };

/**
 * Internal throw-carrier used to abort the transaction AND propagate a
 * typed error up to the outer `try/catch`. Returning `err(...)` from
 * inside `withTx` resolves the callback normally and the sequence
 * allocator's increment commits — instead we throw so the tx rolls
 * back. See `lib/tx-abort.ts` for the shared pattern.
 */
class IssueInvoiceInternalError extends TxAbort<IssueInvoiceError> {
  // Hardcode the class name so production minifiers (esbuild/Terser)
  // can't mangle it in logger output (L3).
  override readonly name = 'IssueInvoiceInternalError';
}

export interface IssueInvoiceDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly memberIdentity: MemberIdentityPort;
  /**
   * 064 S1 — issuance-time refunded re-check for EVENT drafts (TOCTOU vs
   * the draft-time check in createEventInvoiceDraft). REQUIRED even though
   * membership issuance never calls it: an optional safety dep could
   * silently not run (the soft-deleted-plan-hole class).
   */
  readonly eventRegistrationLookup: EventRegistrationLookupPort;
  readonly sequenceAllocator: SequenceAllocatorPort;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly outbox: EmailOutboxPort;
  /**
   * PDF template version to pin on THIS issuance. Normally the
   * composition root wires this to `CURRENT_TEMPLATE_VERSION` (T045).
   * Callers rendering a historical invoice (resend / Blob-miss recovery)
   * pass the row's stored `pdf_template_version` instead (R3-E4).
   */
  readonly currentTemplateVersion: number;
  /**
   * 088-invoice-tax-flow-redesign (T022) — FEATURE_088_TAX_AT_PAYMENT
   * (2-state flow flag). When `'on'`, issue allocates ONLY the non-§87 `bill`
   * number (SC) and renders the ใบแจ้งหนี้; the §86/4 §87 number is minted later
   * at payment. When `'off'` the legacy §87-at-issue §86/4 flow runs unchanged.
   */
  readonly taxAtPayment: TaxAtPaymentFlag;
}

/**
 * Cluster 5 (Finding 1) — the issued invoice PLUS an observable auto-email
 * dispatch outcome. `Invoice & { emailDispatch }` (not a wrapper object) so
 * every existing consumer that reads the value structurally as an `Invoice`
 * (routes, F8 bridges, tests) keeps working; only the callers that WANT the
 * dispatch signal read the extra field.
 */
export type IssueInvoiceSuccess = Invoice & {
  readonly emailDispatch: EmailDispatchOutcome;
};

export async function issueInvoice(
  deps: IssueInvoiceDeps,
  input: IssueInvoiceInput,
): Promise<Result<IssueInvoiceSuccess, IssueInvoiceError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const now = deps.clock.nowIso();

  // T113 — issuance-latency histogram (`invoicing_issue_duration_ms`,
  // p95 target 1.5s per plan § VII). Start the clock at the use-case
  // entry; the `.record()` call on success lives at the end of the
  // happy-path branch so rolled-back attempts aren't logged (would
  // pollute the SLO signal with timings that never produced a §87
  // sequence number).
  const issueStartedAt = performance.now();

  // 065 L-3 — hoisted for the outer catch (as-paid cleanup parity): once
  // set, ANY tx-rejecting failure — typed render/upload errors AND raw
  // rethrows (audit.emit, outbox.enqueue) — may have left bytes at the
  // deterministic key that outlive the rollback. The key is computed in-tx
  // (fy depends on the in-tx settings read) but is deterministic, so the
  // hoisted copy is exact.
  let blobKeyForCleanup: string | null = null;

  try {
  return await deps.invoiceRepo.withTx(async (tx) => {
    // --- PRE-SEQUENCE early exits (safe to `return err(...)` — the tx
    // has no state yet, so a committed callback with zero writes is a
    // no-op. DO NOT reorder code below to put these AFTER allocateNext
    // without converting them to throw-carrier; committing a partial
    // tx that already consumed a sequence number creates a §87 gap.

    // A. Settings
    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'settings_missing' });

    // C1. Row-lock the invoice BEFORE reading the draft — serialises
    // concurrent issue attempts on the same invoice id so two admins
    // clicking "Issue" at once cannot both reach allocateNext.
    const lockedStatus = await deps.invoiceRepo.lockForUpdate(tx, invoiceId, input.tenantId);
    if (!lockedStatus) {
      // R7-W1 — emit cross-tenant probe on not-found (RLS-hidden row
      // looks identical to a genuinely missing id; audit it either
      // way per Constitution Principle I clause 4). Using `null` tx
      // so the audit survives regardless of the outer withTx's
      // commit/rollback outcome — consistent with get-invoice +
      // get-invoice-pdf-signed-url patterns.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Probe on invoice ${invoiceId} (not found on issue)`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_role: 'admin',
          route: 'issue-invoice',
        },
      });
      return err({ code: 'invoice_not_found' });
    }
    if (lockedStatus !== 'draft') {
      return err({ code: 'invoice_already_issued', status: lockedStatus });
    }

    // C2. Draft invoice (now safely inside the row lock)
    const draft = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
    if (!draft) return err({ code: 'invoice_not_found' });

    // 088 US8 (§ F.8 / FR-024 / FR-025) — VAT-treatment gates. FAIL-FAST +
    // PRE-SEQUENCE (plain `return err` — no §87/bill number consumed; runs
    // before buyer resolution, the event gates, and allocateNext):
    //   (1) membership can NEVER be zero-rated (VAT 7% always) → reject, not
    //       coerce (FR-025);
    //   (2) a zero-rated issue REQUIRES a non-blank MFA certificate number
    //       (FR-024). The DB `invoices_zero_rate_cert_required` CHECK is
    //       defense-in-depth behind this app-layer gate.
    const vatTreatment: VatTreatment = input.vatTreatment ?? 'standard';
    // (0) 088 SEC-MED — server-side FEATURE_088_TAX_AT_PAYMENT gate. The
    //     §80/1(5) zero rate is part of the tax-at-payment feature; env.ts's
    //     invariant is "flag off → every invoice is standard 7%". The issue
    //     form only HIDES the zero-rate toggle when the flag is dark — a
    //     crafted request could still forward `zero_rated_80_1_5` and mint a
    //     0%-VAT §86/4 document (burning a §87 number). Refuse it here,
    //     PRE-SEQUENCE (plain `return err`, before allocateNext — no number
    //     consumed; cert fields never pinned), so the flag is the real gate,
    //     not just the UI. `!== 'on'` so the legacy `'off'` flow gates the zero
    //     rate off (`!== 'on'` ≡ `=== 'off'` on the 2-state flow flag).
    if (deps.taxAtPayment !== 'on' && vatTreatment !== 'standard') {
      return err({ code: 'zero_rate_requires_flag' });
    }
    if (
      vatTreatment === 'zero_rated_80_1_5' &&
      draft.invoiceSubject === 'membership'
    ) {
      return err({ code: 'membership_cannot_be_zero_rated' });
    }
    if (
      vatTreatment === 'zero_rated_80_1_5' &&
      (input.zeroRateCertNo ?? '').trim() === ''
    ) {
      return err({ code: 'zero_rate_cert_required' });
    }
    //   (3) UX-B1 review fix — the OPTIONAL cert-scan blob key is client-supplied
    //       (round-tripped from the upload response), so re-validate it here to
    //       THIS tenant + THIS invoice's server-derived cert namespace. A key
    //       matching `invoicing/<tenant>/zero-rate-certs/<invoiceId>_` can only
    //       exist because upload-zero-rate-cert (ClamAV-scanned, server-derived
    //       key) produced it; any other value = an injected arbitrary / unscanned
    //       / cross-tenant blob and is rejected BEFORE it is pinned onto the
    //       10y-immutable row + served by the cert-view route (Blob has no RLS).
    const certBlobKey = input.zeroRateCertBlobKey ?? null;
    if (
      certBlobKey !== null &&
      !certBlobKey.startsWith(
        `invoicing/${input.tenantId}/zero-rate-certs/${input.invoiceId}_`,
      )
    ) {
      return err({ code: 'zero_rate_cert_blob_key_invalid' });
    }

    // B. Buyer resolution — subject-aware (054-event-fee-invoices Task 7;
    // extracted VERBATIM to `lib/resolve-invoice-buyer.ts` in 064 Task 3 so
    // issueEventInvoiceAsPaid composes the same arms instead of copy-pasting).
    //
    //   MEMBERSHIP invoice (memberId non-null) → re-read + LOCK the member
    //   (FR-037 archive-race), snapshot pinned HERE at issue. Also matched-
    //   member EVENT invoices take this branch (their buyer is an F3 member and
    //   the draft pins the snapshot at issue, not draft).
    //
    //   NON-MEMBER event invoice (memberId null) → there is NO F3 member to
    //   read; the buyer snapshot was pinned at DRAFT by createEventInvoiceDraft.
    //   Use that pre-pinned snapshot directly; do NOT call getForIssue.
    //
    // The `invoices_subject_fields_ck` DB CHECK guarantees member_id IS NOT NULL
    // for `invoice_subject='membership'`, so a null memberId here implies an
    // event invoice with a non-member buyer.
    //
    // Err codes pass through 1:1 — member_not_found / member_archived /
    // no_buyer_snapshot are all `IssueInvoiceError` variants. Still in the
    // PRE-SEQUENCE zone (runs BEFORE allocateNext), so the plain
    // `return err(...)` discipline is unchanged.
    const memberId = draft.memberId;
    const buyerResolution = await resolveInvoiceBuyerForIssue(
      deps.memberIdentity,
      tx,
      input.tenantId,
      draft,
    );
    if (!buyerResolution.ok) return err(buyerResolution.error);
    const memberSnap: MemberIdentitySnapshot = buyerResolution.value;

    // 059 / PR-A Task 6a — the buyer's VAT-REGISTRANT status, derived ONCE
    // through the shared Domain resolver and threaded into BOTH decisions below
    // (the event bill-first gate and the PDF doc-kind). Matched member → the
    // RECORDED `members.is_vat_registered` pinned on the snapshot; walk-in
    // (memberId null) → TIN-presence, unchanged (their `tax_id` is
    // `/^\d{13}$/`-locked at the draft boundary, so a passport cannot reach it).
    // See document-kind.ts for the full rationale.
    const buyerIsVatRegistrant = resolveBuyerIsVatRegistrant(memberId, memberSnap);

    // §86/4 doc-type gate (066-membership-no-tin) — subject-based. The PDF
    // document kind is chosen at ISSUE from `invoiceSubject` + whether the
    // resolved BUYER is a VAT REGISTRANT:
    //
    //   MEMBERSHIP + TIN     → kind 'invoice' (ใบกำกับภาษี, buyer TIN shown)
    //   MEMBERSHIP + no TIN  → kind 'invoice' (ใบกำกับภาษี, TIN line ABSENT) — a
    //                          VALID full tax invoice. Per ประกาศอธิบดีฯ ฉบับที่
    //                          199 (eff. 1 Jan 2015) the buyer TIN is mandatory
    //                          ONLY for a VAT-REGISTRANT buyer (so they may claim
    //                          input VAT); a non-registrant — an individual OR an
    //                          unregistered company — gets a §86/4 with
    //                          name+address only. NOT blocked. (Auditor ruling
    //                          2026-06-12: the former `tax_id_required` block,
    //                          commit 39a44edd, rested on the legally-wrong
    //                          premise that a TIN-less full ใบกำกับภาษี is
    //                          illegal — it is not. Even a VAT-registrant buyer
    //                          who withholds their TIN may be issued the invoice;
    //                          only THEIR input-VAT claim is forfeit — the seller
    //                          chamber is never the party at fault.)
    //   EVENT + registrant     → kind 'invoice' (buyer can claim input VAT)
    //   EVENT + non-registrant → kind 'receipt_separate' (ใบเสร็จรับเงิน / §105
    //                          receipt) — billed via the as-paid path, never
    //                          bill-first; the EVENT bill-first block stays below.
    //
    // Buyer name+address completeness (a §86/4 requirement, auditor trap #1) is
    // guaranteed UPSTREAM, so no membership buyer reaches issuance without a
    // renderable buyer block: member `legal_name` is required at creation, and
    // `composeBuyerAddress` carries a non-empty country fallback (so the
    // template's `member.address.split('\n')` can never deref null). The buyer
    // TIN is the ONLY optional particular — the PDF template renders the TIN line
    // conditionally, so an absent TIN simply omits the line (no placeholder).
    //
    // 064 §105 ROOT FIX — a NON-REGISTRANT event buyer can never be billed first:
    // the only legal document for them is a §105 receipt, which may exist
    // only at the moment payment is recorded (issueEventInvoiceAsPaid).
    //
    // 059 / PR-A Task 6a — RE-KEYED off `buyerHasTin(memberSnap.tax_id)` onto the
    // registrant flag, in lockstep with `inferEventDocumentKind` below. These two
    // MUST agree: if this gate let a non-registrant member through (because their
    // `tax_id` holds a passport, so `buyerHasTin` was true) the doc-kind below
    // would resolve 'receipt_separate' while `applyIssue` hardcodes
    // `pdfDocKind: 'invoice'` — rendering a §105 ใบเสร็จรับเงิน for an UNPAID
    // bill, re-opening the exact violation the 064 root fix closed.
    //
    // The error CODE keeps its `_no_tin_` name (it is load-bearing across ~15
    // sites — route map, i18n ×3, payments bridge, portal gate, tests); its
    // MEANING widens from "no TIN" to "not a VAT registrant". Renaming it is a
    // separate, mechanical change.
    if (draft.invoiceSubject === 'event' && !buyerIsVatRegistrant) {
      return err({ code: 'event_no_tin_requires_paid_issue' });
    }
    // 064 S1 — refunded re-check at ISSUANCE (TOCTOU close). The draft-time
    // check in createEventInvoiceDraft only covers the moment of drafting; a
    // registration refunded between draft and issue would otherwise still be
    // billed (asserting a fee the buyer got back). Runs in-tx (same RLS
    // context, after the row lock) and PRE-allocation, so a refunded reject
    // burns no §87 number. `ok(null)`/port-err are a verification failure —
    // never issue a tax document against an unverifiable registration.
    // Subject-scoped: membership drafts have no registration to re-check.
    if (draft.invoiceSubject === 'event') {
      const regResult = await deps.eventRegistrationLookup.findById(
        tx,
        input.tenantId,
        draft.eventRegistrationId,
      );
      if (!regResult.ok || regResult.value === null) {
        // 065 M-2 — the single public code collapses TWO failure modes that
        // ops must tell apart: `not_found` (row vanished under RLS — a
        // data-integrity anomaly the F6 adapter logs NOTHING for) vs
        // `port_error` (the adapter already error-logged the underlying
        // failure; this line adds the invoice context it lacks).
        logger.error(
          {
            reason: regResult.ok ? 'not_found' : 'port_error',
            invoiceId: input.invoiceId,
            tenantId: input.tenantId,
            registrationId: draft.eventRegistrationId,
          },
          'issueInvoice: registration lookup failed at issuance re-check',
        );
        return err({ code: 'registration_lookup_failed' });
      }
      if (regResult.value.paymentStatus === 'refunded') {
        return err({ code: 'registration_refunded' });
      }
    }
    // After the two gates above, an event subject always resolves to 'invoice'
    // here — 'receipt_separate' at plain issue is unreachable (applyIssue's
    // port type still allows it; the as-paid path is the live writer of
    // receipt kinds).
    const pdfKind: PdfDocKind = inferEventDocumentKind(
      draft.invoiceSubject,
      buyerIsVatRegistrant,
    );

    // Domain invariant — exactly one subject-defining line required before issue
    // (`membership_fee` for membership, `event_fee` for event). Runs BEFORE
    // allocateNext so a malformed draft cannot consume a §87 sequence number.
    const linesCheck = enforceOneSubjectLine(draft.invoiceSubject, draft.lines);
    if (!linesCheck.ok) {
      return err({
        code: 'invalid_lines',
        reason: linesCheck.error.code,
      });
    }

    // D. Fiscal year
    const fy = fiscalYearFromUtcIso(
      now,
      settings.fiscalYearStartMonth as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
    );

    // --- POST-SEQUENCE zone begins. Every error path below MUST throw
    // an `IssueInvoiceInternalError` so withTx rolls back and the
    // allocator's increment is NOT committed.

    // E. Allocate the document number.
    //
    // 088 US1 (T017) — the stream depends on FEATURE_088_TAX_AT_PAYMENT:
    //   NEW flow (taxAtPayment) — the pre-payment document is a NON-tax
    //     ใบแจ้งหนี้ numbered from the `bill` stream (prefix from
    //     `invoiceNumberPrefix` → 'SC' at cutover). NO §87 number is consumed
    //     at issue; the §86/4 §87 `RC` number is minted later at payment
    //     (record-payment.ts). A gap in the bill stream is LEGAL — §87 does not
    //     govern a non-tax document (research §2/§3). The overflow-must-throw
    //     §87 no-gaps discipline moves WITH the §87 allocation to payment time.
    //   LEGACY flow — the §86/4 §87 `invoice`-stream number is allocated HERE.
    //     Event + membership invoices INTENTIONALLY share the single
    //     `documentType:'invoice'` §87 stream (Thai RD §87 continuity).
    const taxAtPayment = deps.taxAtPayment === 'on';
    const seq = await deps.sequenceAllocator.allocateNext(tx, {
      tenantId: input.tenantId,
      documentType: taxAtPayment ? 'bill' : 'invoice',
      fiscalYear: fy,
    });
    const docNum = DocumentNumber.of(settings.invoiceNumberPrefix, fy, seq);
    if (!docNum.ok) {
      // Critical: overflow happens AFTER allocateNext — must throw, not
      // return err, otherwise the tx commits. On the legacy stream this leaks
      // a §87 gap; on the bill stream a gap is legal but the tx must still roll
      // back so a bill row without a valid number never commits.
      throw new IssueInvoiceInternalError({ code: 'overflow', fiscalYear: fy });
    }

    // F. Pricing from lines (054-event-fee-invoices — Model A vs Model B).
    //
    //   Sum the line totals once. Then branch on `draft.vatInclusive`:
    //
    //   - VAT-EXCLUSIVE (membership, vatInclusive=false): the line sum IS the
    //     subtotal; VAT is added on top → `calculateVat`. UNCHANGED F4 behaviour.
    //
    //   - VAT-INCLUSIVE (event Model B, vatInclusive=true): the single event_fee
    //     line stores the all-in ticket price, so the line sum IS the total. Back-
    //     calculate subtotal + VAT via `splitVatInclusive` (subtotal = round-half-
    //     away(total × 10000/(10000+bps)); vat = total − subtotal). This preserves
    //     the inclusive amount EXACTLY (subtotal+vat===total by construction) and
    //     avoids the ~6.5% off-by-1-satang mismatch a store-subtotal-then-recompute
    //     path produces (e.g. 100.04 THB → total stays 10004, not 10005).
    let lineSum = Money.zero();
    for (const line of draft.lines) {
      lineSum = lineSum.add(line.total);
    }
    // 088 US8 (FR-025 / G3) — `vat_treatment` DRIVES the rate (single source of
    // truth): a `'zero_rated_80_1_5'` issue computes at 0%, everything else at
    // the tenant's configured standard rate. The rate is NEVER chosen
    // independently of the treatment. Both the inclusive + exclusive branches +
    // the persisted `vatRateSnapshot` use THIS derived rate.
    const effectiveVatRate = resolveVatRate(vatTreatment, settings.vatRate);
    let subtotal: Money;
    let vat: Money;
    let total: Money;
    if (draft.vatInclusive) {
      total = lineSum;
      ({ subtotal, vat } = splitVatInclusive(total, effectiveVatRate.numerator));
    } else {
      subtotal = lineSum;
      ({ vat, total } = calculateVat(subtotal, effectiveVatRate));
    }

    // G. Snapshots — `tenantSnap` is the seller; `memberSnap` is the BUYER,
    // resolved above (membership/matched-member from getForIssue; non-member
    // event from the draft's pre-pinned snapshot).
    const tenantSnap = settings.identity;

    // Dates — invoice date follows wall-clock Bangkok, not UTC, so an
    // issuance at 23:30 UTC (= 06:30 Bangkok next day) shows the correct
    // local calendar date on the document.
    const issueDate = bangkokLocalDate(now);
    const dueDate = addDays(issueDate, settings.defaultNetDays);

    // H+I. Render PDF + upload to Blob (T126 shared helper).
    // Throws via `IssueInvoiceInternalError` on either failure so
    // `withTx` rolls back — sequence allocation is NOT consumed.
    //
    // Wave-3 S27 note: issueEventInvoiceAsPaid hoists this logo fetch
    // OUT of the §87 critical section (its settings read is pre-tx, so the
    // logo key is known before withTx opens). HERE the settings read lives
    // INSIDE withTx (step A above), so hoisting the logo would mean
    // restructuring that read too — left in-tx deliberately; the in-process
    // logo cache keeps the steady-state cost at ~0 anyway.
    const blobKey = `invoicing/${input.tenantId}/${fy}/${invoiceId}_v${deps.currentTemplateVersion}.pdf`;
    blobKeyForCleanup = blobKey;
    const tenantLogo = await loadTenantLogo(
      deps.blob,
      tenantSnap.logo_blob_key,
      deps.currentTemplateVersion,
    );
    const rendered = await renderAndUploadPdf(
      { pdfRender: deps.pdfRender, blob: deps.blob },
      {
        renderInput: {
          kind: pdfKind,
          templateVersion: deps.currentTemplateVersion,
          documentNumber: docNum.value,
          issueDate,
          dueDate,
          tenant: tenantSnap,
          tenantLogo,
          member: memberSnap,
          // 059 / PR-A Task 6b — the SAME resolved value used for the doc-kind /
          // bill-first gate decisions above, threaded so the Tax ID line's print
          // decision can never disagree with the class decision that chose this
          // document's `kind`.
          lines: draft.lines,
          subtotal,
          // 088 US8 (FR-025) — the DERIVED rate (0% for zero-rate), never the
          // raw tenant standard rate.
          vatRate: effectiveVatRate,
          vat,
          total,
          // 054-event-fee-invoices — VAT-inclusive flag drives the "VAT included"
          // annotation on event Model-B documents (gross line + net subtotal +
          // VAT + total read coherently). Membership invoices are VAT-exclusive.
          vatInclusive: draft.vatInclusive,
          // 088 T016 — render the pre-payment document as the non-tax ใบแจ้งหนี้
          // (no §86/4 title / ORIGINAL marker / §-citation) in the new flow.
          billMode: taxAtPayment,
          // 088 US5 (T041 / FR-012) — gate the tenant WHT note (membership only)
          // + let the template render the bank block on a membership bill.
          invoiceSubject: draft.invoiceSubject,
          // 088 US8 (T058 / FR-025 / SC-008) — thread the pinned zero-rate
          // treatment + cert ONLY on a zero-rated document so a standard render
          // is byte-identical (undefined → omitted from the JSON seed, SC-003).
          // The bill itself renders no §80/1(5) note (the note is §86/4-receipt
          // only) but the 0% VAT is already driven by `vatRate`/`vat` above.
          ...(vatTreatment === 'zero_rated_80_1_5'
            ? {
                vatTreatment,
                zeroRateCertNo: input.zeroRateCertNo ?? null,
                zeroRateCertDate: input.zeroRateCertDate ?? null,
              }
            : {}),
        },
        blobKey,
      },
      (code, reason) => new IssueInvoiceInternalError({ code, reason }),
    );

    // J. UPDATE invoices row. The repo throws if the status guard
    // (WHERE status='draft') doesn't match — treat that as a
    // concurrent re-issue race and surface it as a typed error so the
    // route maps to 409 instead of 500.
    let issued;
    try {
      issued = await deps.invoiceRepo.applyIssue(tx, {
        tenantId: input.tenantId,
        invoiceId,
        fiscalYear: fy,
        // 088 US1 — NEW flow writes the non-§87 bill number (SC) to
        // bill_document_number_raw with a NULL §87 sequence/document pair;
        // LEGACY writes the §87 pair. The DB CHECK enforces exactly one leg.
        sequenceNumber: taxAtPayment ? null : seq,
        documentNumber: taxAtPayment ? null : docNum.value.raw,
        billDocumentNumberRaw: taxAtPayment ? docNum.value.raw : null,
        // 088 US8 (§ F.8 / FR-023) — pin the per-invoice VAT treatment + MFA
        // certificate onto the issued row (immutable via the 0234 trigger).
        // 'standard' + NULL cert on every non-zero-rate issue.
        vatTreatment,
        zeroRateCertNo: input.zeroRateCertNo ?? null,
        zeroRateCertDate: input.zeroRateCertDate ?? null,
        zeroRateCertBlobKey: certBlobKey,
        issueDate,
        dueDate,
        // F5R3 H-5 (2026-05-16) — brand at Money VO escape to port input.
        subtotalSatang: asSatang(subtotal.satang),
        // 088 US8 (FR-025) — persist the DERIVED rate (0% for zero-rate), so the
        // stored snapshot matches the rendered document.
        vatRate: effectiveVatRate.raw,
        vatSatang: asSatang(vat.satang),
        totalSatang: asSatang(total.satang),
        // 054-event-fee-invoices — pro-rating is membership-only, so event
        // invoices persist NULL here (the relaxed non-draft CHECK, migration
        // 0203, permits `pro_rate_policy_snapshot IS NULL` iff subject='event').
        proRatePolicySnapshot:
          draft.invoiceSubject === 'event' ? null : settings.proRatePolicy,
        netDaysSnapshot: settings.defaultNetDays,
        tenantIdentitySnapshot: tenantSnap,
        memberIdentitySnapshot: memberSnap,
        pdf: {
          blobKey,
          sha256: rendered.sha256,
          templateVersion: deps.currentTemplateVersion,
        },
        // 064 (Task 2, dead arm fixed wave-4 S21; 066 membership-no-tin relax) —
        // persist WHAT the rendered main PDF is. Every plain-issue path resolves
        // `pdfKind === 'invoice'`: membership ALWAYS (with or without a buyer TIN
        // — 066 removed the membership TIN gate), event-with-TIN, and event-no-TIN
        // is blocked above (event_no_tin_requires_paid_issue → §105 as-paid path).
        // 'receipt_separate' is unreachable here (the as-paid use case is the only
        // live writer of receipt kinds), so the constant is faithful and the
        // former narrowing ternary's false arm was dead code.
        pdfDocKind: 'invoice',
      });
    } catch (e) {
      if (e instanceof InvoiceApplyConflictError && e.kind === 'applyIssue') {
        // Row was 'draft' under the lock but isn't anymore — concurrent
        // re-issue. Surface 'issued' as the inferred new status so
        // callers (and the 409 response) carry useful info.
        throw new IssueInvoiceInternalError({
          code: 'invoice_already_issued',
          status: 'issued',
        });
      }
      throw e;
    }

    // K. Audit `invoice_issued` — branch on buyer kind (054-event-fee-invoices).
    //
    //   MEMBERSHIP / matched-member (memberId non-null) → TIMELINE branch: the
    //   payload carries `member_id` so the F3 member timeline filter
    //   (`payload->>'member_id'`) surfaces the issuance. UNCHANGED F4 behaviour.
    //
    //   NON-MEMBER event (memberId null) → NON-timeline branch: the buyer is not
    //   an F3 member, so the timeline filter MUST NOT surface it. We do NOT widen
    //   `MemberTimelineAuditPayload` to make `member_id` optional (that would
    //   weaken the F3 `member_id` guarantee for the member-timeline event types); instead
    //   we narrow `invoice_issued` to the non-timeline `F4AuditEvent` branch at
    //   THIS one site, carrying `event_registration_id` and omitting `member_id`
    //   entirely. Mirrors the `emitNonTimelineDraftCreated` precedent in
    //   create-event-invoice-draft.ts.
    const issuedSummary = `Invoice ${docNum.value.raw} issued`;
    // 088 US1 — the audit payload reflects WHICH number was minted. NEW flow:
    // the non-§87 bill number (bill_document_number_raw) + a `tax_number_consumed:
    // false` marker (the §87 §86/4 number is minted at payment, on
    // tax_receipt_issued). LEGACY: the §87 sequence/document pair as before.
    const issuedPayloadBase: Record<string, unknown> = {
      invoice_id: invoiceId,
      fiscal_year: fy,
      sequence_number: taxAtPayment ? null : seq,
      document_number: taxAtPayment ? null : docNum.value.raw,
      ...(taxAtPayment
        ? { bill_document_number_raw: docNum.value.raw, tax_number_consumed: false }
        : {}),
      total_satang: total.satang.toString(),
      pdf_sha256: rendered.sha256,
      // 088 US8 (T060 / § F.8.3) — record the pinned VAT treatment + (when
      // zero-rated) the MFA cert number on `invoice_issued`. No new event type.
      vat_treatment: vatTreatment,
      zero_rate_cert_no: input.zeroRateCertNo ?? null,
    };
    if (memberId !== null) {
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_issued',
        actorUserId: input.actorUserId,
        summary: issuedSummary,
        payload: {
          member_id: memberId,
          ...issuedPayloadBase,
        },
      });
    } else {
      // NON-MEMBER event invoice. `invoices_subject_fields_ck` guarantees
      // `event_registration_id IS NOT NULL` whenever `member_id IS NULL`; TS only
      // knows `memberId === null`, so re-narrow on the column. The typed
      // `emitNonMemberInvoiceEvent` helper REQUIRES `event_registration_id` and
      // FORBIDS `member_id` at compile time (no `as` cast) so the F3 timeline
      // filter (`payload->>'member_id'`) never surfaces a non-member row.
      if (draft.eventRegistrationId === null) {
        throw new Error(
          'issueInvoice: non-member invoice has null event_registration_id (violates invoices_subject_fields_ck)',
        );
      }
      await emitNonMemberInvoiceEvent(deps.audit, tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_issued',
        eventRegistrationId: draft.eventRegistrationId,
        actorUserId: input.actorUserId,
        summary: issuedSummary,
        extraPayload: {
          event_id: draft.eventId,
          ...issuedPayloadBase,
        },
      });
    }

    // L. Outbox (if auto-email enabled — per-invoice override trumps tenant default)
    //
    // Task 14 — auto-email is BEST-EFFORT and NOT part of the issue tx
    // invariant: the §87 sequence number + PDF + audit are already committed
    // above; the enqueue is a single row insert and a skip here leaves the
    // issued invoice fully valid (admins can manually resend from the detail
    // page). Two Task-14 hardenings on this path:
    //
    //   (A) Empty-recipient guard — a NON-MEMBER event buyer may have an
    //       empty `primary_contact_email` (the buyer snapshot accepts ''
    //       per §86/4: a contact is supplementary, not required). Enqueuing
    //       to '' would queue an undeliverable row. Skip + warn (ids only,
    //       NO email/PII per CLAUDE.md § Secrets) instead.
    //
    //   (B) Non-member event privacy footer — when the buyer is a non-member
    //       on an EVENT invoice, thread `privacyFooterKind = 'event_non_member'`
    //       so the auto-email carries the §87/3 PDPA transparency notice.
    const shouldAutoEmail =
      draft.autoEmailOnIssue ?? settings.autoEmailEnabled;
    // Cluster 5 (Finding 1) — observable dispatch outcome. `'disabled'` when
    // auto-email is intentionally off (tenant default or per-invoice override);
    // otherwise the helper reports 'sent' vs 'skipped_no_email'.
    let emailDispatch: EmailDispatchOutcome = 'disabled';
    if (shouldAutoEmail) {
      // (A)+(B) live in the shared helper (wave-4 S15) — trim + skip-with-
      // warn+metric on an empty buyer email; otherwise ONE outbox row with
      // the non-member-event PDPA footer. An enqueue THROW still rolls the
      // whole issue tx back (the helper only swallows the empty-recipient
      // skip).
      emailDispatch = await enqueueInvoiceAutoEmail(deps.outbox, tx, {
        tenantId: input.tenantId,
        invoiceId,
        invoiceSubject: draft.invoiceSubject,
        eventType: 'invoice_issued',
        recipientEmail: memberSnap.primary_contact_email ?? null,
        pdfBlobKey: blobKey,
        pdfTemplateVersion: deps.currentTemplateVersion,
        privacyFooterKind:
          draft.invoiceSubject === 'event' && draft.memberId === null
            ? ('event_non_member' as const)
            : undefined,
        skipLogMessage: 'issueInvoice: auto-email skipped — buyer has no contact email',
      });
    }

    // T113 — happy-path emit. Count + duration fire together so
    // rate(issue_total) × avg(issue_duration_ms) = total issuance
    // wall-time on the dashboard.
    invoicingMetrics.issueCount();
    invoicingMetrics.issueDurationMs(performance.now() - issueStartedAt);
    // Cluster 5 (Finding 1) — thread the auto-email outcome alongside the
    // issued invoice (subtype of `Invoice`, so no consumer breaks).
    return ok({ ...issued, emailDispatch });
  });
  } catch (e) {
    // 065 L-3 — orphan-blob mitigation, ported from issueEventInvoiceAsPaid's
    // catch (review Important #1 rationale applies verbatim): any failure
    // after the upload rejected the tx, so bytes at the deterministic key
    // outlive the rollback while the row stays draft. Worse, on a NEXT-DAY
    // retry the re-render produces DIFFERENT bytes (issueDate moves with the
    // clock) while the adapter's conflict-as-success arm returns the OLD
    // bytes — the row would commit a pdf_sha256 that doesn't match the
    // stored document. Clean up on every caught error EXCEPT:
    //   - `invoice_already_issued` (applyIssue conflict translation): the
    //     race WINNER may legitimately own bytes at that key; and
    //   - `pdf_render_failed`: the render runs BEFORE the upload inside
    //     renderAndUploadPdf — THIS attempt wrote nothing at the key.
    // Best-effort (awaited, failure logged + counted, never masks the
    // original error). The wave-3 S33 successor-race residual accepted on
    // the as-paid path applies here identically.
    const orphanBlobKey = blobKeyForCleanup;
    const skipOrphanCleanup =
      e instanceof IssueInvoiceInternalError &&
      (e.error.code === 'invoice_already_issued' || e.error.code === 'pdf_render_failed');
    if (orphanBlobKey !== null && !skipOrphanCleanup) {
      await deps.blob.delete(orphanBlobKey).catch((delErr: unknown) => {
        // 065 H-1b parity — ERROR + alertable counter: stale bytes remain at
        // the key and (unlike as-paid) THIS path has no allowOverwrite
        // retry, so the drift risk stands until the orphan is swept.
        logger.error(
          { err: delErr, invoiceId: input.invoiceId, blobKey: orphanBlobKey },
          'issueInvoice: orphan blob cleanup failed',
        );
        invoicingMetrics.orphanBlobCleanupFailed('issue');
      });
    }
    if (e instanceof IssueInvoiceInternalError) {
      // 065 M-4 — severity split: overflow (tenant-wide §87 number-space
      // outage) and pdf/blob infrastructure failures are 500-class server
      // faults → ERROR; business rejects carried by the throw-only zone
      // (the invoice_already_issued race loser) stay WARN.
      const isServerFault =
        e.error.code === 'overflow' ||
        e.error.code === 'pdf_render_failed' ||
        e.error.code === 'blob_upload_failed';
      const logPayload = {
        err: e.error,
        invoiceId: input.invoiceId,
        tenantId: input.tenantId,
      };
      if (isServerFault) {
        logger.error(logPayload, 'issueInvoice: internal error, rolling back');
      } else {
        logger.warn(logPayload, 'issueInvoice: internal error, rolling back');
      }
      if (e.error.code === 'overflow') {
        invoicingMetrics.issuanceOverflow(input.tenantId, e.error.fiscalYear);
      }
      // T122 — emit `pdf_render_failed` audit AFTER the tx rolled
      // back so forensic evidence survives (the original in-tx audit
      // would have rolled back with the mutation). Fire-and-forget:
      // never mask the original error with an audit-write failure.
      if (e.error.code === 'pdf_render_failed') {
        try {
          await deps.audit.emit(null, {
            tenantId: input.tenantId,
            requestId: input.requestId ?? null,
            eventType: 'pdf_render_failed',
            actorUserId: input.actorUserId,
            summary: `PDF render failed for invoice ${input.invoiceId}`,
            payload: {
              invoice_id: input.invoiceId,
              render_kind: 'invoice',
              reason: e.error.reason,
            },
          });
        } catch (auditErr) {
          logger.warn(
            { err: auditErr, invoiceId: input.invoiceId },
            'issueInvoice: pdf_render_failed audit emit also failed',
          );
        }
      }
      return err(e.error);
    }
    // 059 PR-A Task 4 fix (thai-tax-compliance-auditor HIGH) — the Domain
    // VO's write-time invariant fired: `resolveInvoiceBuyerForIssue` (step B,
    // PRE-SEQUENCE — runs before allocateNext) resolved a buyer who is a VAT
    // registrant with no tax_id, and `makeMemberIdentitySnapshot` (called by
    // the member-identity adapter) THROWS rather than returning a Result. No
    // §87 number was ever burned. Audited the same way pdf_render_failed is
    // (T122 pattern): the tx is already dead by the time we're here, so
    // tx=null; fire-and-forget, never mask the original error with an
    // audit-write failure. Today this is the ONLY zod issue this VO can
    // raise from a live DB read (the member_number/branch_code pairings are
    // guaranteed upstream by DB CHECKs), so the mapping to a single dedicated
    // code is deliberate, not a generic "malformed snapshot" catch-all.
    if (e instanceof InvalidMemberIdentitySnapshotError) {
      logger.warn(
        { invoiceId: input.invoiceId, tenantId: input.tenantId, issues: e.issues },
        'issueInvoice: buyer identity snapshot invalid at issue time (VAT registrant with no tax_id), rolling back',
      );
      try {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_buyer_identity_invalid',
          actorUserId: input.actorUserId,
          summary: `Invoice ${input.invoiceId} issuance blocked — buyer identity snapshot invalid`,
          payload: {
            invoice_id: input.invoiceId,
            issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
          },
        });
      } catch (auditErr) {
        logger.warn(
          { err: auditErr, invoiceId: input.invoiceId },
          'issueInvoice: invoice_buyer_identity_invalid audit emit also failed',
        );
      }
      return err({ code: 'buyer_tax_id_required_for_registrant' });
    }
    throw e;
  }
}
