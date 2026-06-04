/**
 * T037 — issue-invoice use case (F4).
 *
 * THE critical transactional path per plan § VIII Reliability.
 *
 * Canonical lock order (documented below so reviewers can spot-check):
 *   1. invoice row FOR UPDATE (lockForUpdate — serialises concurrent issues)
 *   2. member FOR UPDATE (archive-race guard FR-037)
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
 *   B. load + lock member (archive-race guard)
 *   C. load + lock invoice draft
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
 * Any throw in A-L rolls back the whole tx — seq is NOT consumed, Blob
 * upload leaves an orphan that the transactional sweeper cleans up
 * (orphans are deterministic and safe to delete because the Blob key is
 * content-addressed on tenant+id+template).
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
import type { SequenceAllocatorPort } from '../ports/sequence-allocator-port';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type {
  AuditPort,
  F4AuditEventType,
  F4MemberTimelineAuditEventType,
} from '../ports/audit-port';
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
import { splitVatInclusive } from '@/modules/invoicing/domain/value-objects/vat-inclusive';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { bangkokLocalDate, addDays } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { renderAndUploadPdf } from '../lib/render-and-upload';
import { loadTenantLogo } from '../lib/load-tenant-logo';

export const issueInvoiceSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
});

export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;

export type IssueInvoiceError =
  | { code: 'invoice_not_found' }
  | { code: 'invoice_already_issued'; status: InvoiceStatus }
  | { code: 'settings_missing' }
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'tax_id_required' }
  /**
   * 054-event-fee-invoices — a NON-member event invoice reached issue without a
   * buyer snapshot pinned at draft. `createEventInvoiceDraft` always pins the
   * non-member buyer snapshot, so this is a data-integrity guard (corrupted /
   * hand-written draft) rather than a normal flow.
   */
  | { code: 'no_buyer_snapshot' }
  | { code: 'invalid_lines'; reason: string }
  | { code: 'overflow'; fiscalYear: FiscalYear }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string };

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
}

export async function issueInvoice(
  deps: IssueInvoiceDeps,
  input: IssueInvoiceInput,
): Promise<Result<Invoice, IssueInvoiceError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const now = deps.clock.nowIso();

  // T113 — issuance-latency histogram (`invoicing_issue_duration_ms`,
  // p95 target 1.5s per plan § VII). Start the clock at the use-case
  // entry; the `.record()` call on success lives at the end of the
  // happy-path branch so rolled-back attempts aren't logged (would
  // pollute the SLO signal with timings that never produced a §87
  // sequence number).
  const issueStartedAt = performance.now();

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

    // B. Buyer resolution — subject-aware (054-event-fee-invoices Task 7).
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
    const memberId = draft.memberId;
    let memberSnap: MemberIdentitySnapshot;
    if (memberId !== null) {
      const member = await deps.memberIdentity.getForIssue(
        tx,
        input.tenantId,
        memberId,
        { forUpdate: true },
      );
      if (!member) return err({ code: 'member_not_found' });
      if (member.isArchived) return err({ code: 'member_archived' });

      // S1-P1-16 — a Thai tax invoice for a COMPANY member must carry the buyer's
      // tax_id (FR-009a / Revenue Code §86). Person tiers (memberTypeScope
      // 'individual'/'both'/null) are exempt. Early-exit BEFORE allocateNext so a
      // missing tax_id never burns a §87 sequence number. Defense-in-depth: the
      // member importer already requires tax_id at company-member entry.
      //
      // KNOWN FUTURE-TENANT GAP: a `'both'`-scope plan admits BOTH company and
      // person members, so a company entity on a 'both' plan would be exempted
      // here. No SweCham 2026 plan uses 'both' (corporate tiers are 'company',
      // partnership tiers 'individual'), so there is no live defect. A future
      // tenant introducing a 'both' plan with company members must re-scope this
      // gate to the member's entity type rather than the plan scope.
      //
      // For matched-member EVENT invoices the same gate also ran at DRAFT
      // (createEventInvoiceDraft) so it cannot be bypassed by going straight to
      // issue; re-running it here on the freshly-locked member is harmless.
      if (
        member.memberTypeScope === 'company' &&
        (member.snapshot.tax_id ?? '').trim() === ''
      ) {
        return err({ code: 'tax_id_required' });
      }
      memberSnap = member.snapshot;
    } else {
      // Non-member event buyer — the snapshot was pinned at draft. Validate it
      // is present (data-integrity guard; the draft use-case always pins it).
      if (draft.memberIdentitySnapshot === null) {
        return err({ code: 'no_buyer_snapshot' });
      }
      memberSnap = draft.memberIdentitySnapshot;
    }

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

    // E. Allocate sequence
    const seq = await deps.sequenceAllocator.allocateNext(tx, {
      tenantId: input.tenantId,
      documentType: 'invoice',
      fiscalYear: fy,
    });
    const docNum = DocumentNumber.of(settings.invoiceNumberPrefix, fy, seq);
    if (!docNum.ok) {
      // Critical: overflow happens AFTER allocateNext — must throw, not
      // return err, otherwise the tx commits and we leak a §87 gap.
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
    let subtotal: Money;
    let vat: Money;
    let total: Money;
    if (draft.vatInclusive) {
      total = lineSum;
      ({ subtotal, vat } = splitVatInclusive(total, settings.vatRate.numerator));
    } else {
      subtotal = lineSum;
      ({ vat, total } = calculateVat(subtotal, settings.vatRate));
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
    const blobKey = `invoicing/${input.tenantId}/${fy}/${invoiceId}_v${deps.currentTemplateVersion}.pdf`;
    const tenantLogo = await loadTenantLogo(
      deps.blob,
      tenantSnap.logo_blob_key,
      deps.currentTemplateVersion,
    );
    const rendered = await renderAndUploadPdf(
      { pdfRender: deps.pdfRender, blob: deps.blob },
      {
        renderInput: {
          kind: 'invoice',
          templateVersion: deps.currentTemplateVersion,
          documentNumber: docNum.value,
          issueDate,
          dueDate,
          tenant: tenantSnap,
          tenantLogo,
          member: memberSnap,
          lines: draft.lines,
          subtotal,
          vatRate: settings.vatRate,
          vat,
          total,
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
        sequenceNumber: seq,
        documentNumber: docNum.value.raw,
        issueDate,
        dueDate,
        // F5R3 H-5 (2026-05-16) — brand at Money VO escape to port input.
        subtotalSatang: asSatang(subtotal.satang),
        vatRate: settings.vatRate.raw,
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
    //   weaken the F3 `member_id` guarantee for the 5 membership events); instead
    //   we narrow `invoice_issued` to the non-timeline `F4AuditEvent` branch at
    //   THIS one site, carrying `event_registration_id` and omitting `member_id`
    //   entirely. Mirrors the `emitNonTimelineDraftCreated` precedent in
    //   create-event-invoice-draft.ts.
    const issuedSummary = `Invoice ${docNum.value.raw} issued`;
    if (memberId !== null) {
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_issued',
        actorUserId: input.actorUserId,
        summary: issuedSummary,
        payload: {
          invoice_id: invoiceId,
          member_id: memberId,
          fiscal_year: fy,
          sequence_number: seq,
          document_number: docNum.value.raw,
          total_satang: total.satang.toString(),
          pdf_sha256: rendered.sha256,
        },
      });
    } else {
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        // Cast: `invoice_issued` is a timeline-listed type, but for the no-member
        // event variant we deliberately emit on the non-timeline branch (no
        // member_id available; the buyer is not an F3 member). The runtime
        // adapter is event-type-agnostic — only the compile-time payload contract
        // differs. Same documented escape as create-event-invoice-draft.ts.
        eventType: 'invoice_issued' as Exclude<
          F4AuditEventType,
          F4MemberTimelineAuditEventType
        >,
        actorUserId: input.actorUserId,
        summary: issuedSummary,
        payload: {
          invoice_id: invoiceId,
          event_registration_id: draft.eventRegistrationId,
          event_id: draft.eventId,
          fiscal_year: fy,
          sequence_number: seq,
          document_number: docNum.value.raw,
          total_satang: total.satang.toString(),
          pdf_sha256: rendered.sha256,
        },
      });
    }

    // L. Outbox (if auto-email enabled — per-invoice override trumps tenant default)
    const shouldAutoEmail =
      draft.autoEmailOnIssue ?? settings.autoEmailEnabled;
    if (shouldAutoEmail) {
      await deps.outbox.enqueue(tx, {
        tenantId: input.tenantId,
        eventType: 'invoice_issued',
        recipientEmail: memberSnap.primary_contact_email,
        invoiceId,
        pdfBlobKey: blobKey,
        pdfTemplateVersion: deps.currentTemplateVersion,
      });
    }

    // T113 — happy-path emit. Count + duration fire together so
    // rate(issue_total) × avg(issue_duration_ms) = total issuance
    // wall-time on the dashboard.
    invoicingMetrics.issueCount();
    invoicingMetrics.issueDurationMs(performance.now() - issueStartedAt);
    return ok(issued);
  });
  } catch (e) {
    if (e instanceof IssueInvoiceInternalError) {
      logger.warn(
        {
          err: e.error,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'issueInvoice: internal error, rolling back',
      );
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
    throw e;
  }
}
