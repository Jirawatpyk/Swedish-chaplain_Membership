/**
 * T109 — Overdue derivation (F4 / Phase 10b).
 *
 * Research decision R2-E3 (see `specs/007-invoices-receipts/research.md`):
 * overdue is a DERIVED view, not a stored transition. The pure helper
 * here adds `isOverdue: boolean` to an invoice DTO by evaluating
 * `status === 'issued' && bangkok(now) > dueDate`. Recording payment
 * or voiding returns the invoice to its correct explicit status with
 * no reverse-transition cost.
 *
 * Companion idempotent audit emit (FR-028 + R2-E3):
 *   On the first read per (tenant, invoice, Bangkok-local day) that
 *   detects an overdue invoice, emit `invoice_overdue_detected`. The
 *   partial unique index `audit_log_overdue_once_per_day` (migration
 *   0021) guarantees at-most-once per invoice per local day even
 *   under concurrent reads — `INSERT … ON CONFLICT DO NOTHING` silently
 *   swallows duplicates. Audit is opportunistic (timeline completeness
 *   only); FR-028 compliance does NOT depend on the audit landing.
 *
 * Callers:
 *   - `listInvoicesPaged` — decorates each row after loading.
 *   - Admin + portal detail pages — decorate the single loaded invoice
 *     before rendering.
 *
 * Cost model:
 *   - Pure derive: ~2 µs per invoice (string compare on YYYY-MM-DD).
 *   - Emit side-effect: at most one INSERT per (invoice, day) thanks
 *     to the unique index + ON CONFLICT DO NOTHING. Bulk list reads
 *     that find N overdue invoices fire N emit attempts; most are
 *     duplicate no-ops. A future polish (post-MVP) may batch the N
 *     inserts into a single INSERT … VALUES (...) ON CONFLICT.
 */
import { billFirstDocumentNumber, type Invoice } from '@/modules/invoicing/domain/invoice';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import type { OverdueAuditPort } from '../ports/overdue-audit-port';

/**
 * Decorated invoice carrying the derived `isOverdue` boolean.
 *
 * Intentionally additive, not replacing `status` — consumers that
 * need the stored state (e.g. `void` guard in admin actions) MUST
 * keep reading `invoice.status`. `isOverdue` is presentation-only.
 */
// 054-event-fee-invoices — `Invoice` is now a discriminated union on
// `invoiceSubject`, so this decorator is an INTERSECTION (`Invoice & …`) rather
// than `interface … extends Invoice`. The `& { isOverdue }` distributes across
// both union arms, preserving the discriminant so consumers can still narrow on
// `invoiceSubject` and read every shared field (`invoiceId`, `status`, …).
export type InvoiceWithOverdue = Invoice & {
  readonly isOverdue: boolean;
};

/**
 * Pure derivation — no side effects, no deps, trivially unit-testable.
 *
 * Overdue rules (FR-028):
 *   1. status must be 'issued' — paid / void / credited / etc. are not overdue
 *      regardless of dueDate (payment/void resolved the obligation).
 *   2. dueDate must be non-null (defensive — issued invoices always have one).
 *   3. today (Bangkok-local) must be STRICTLY GREATER than dueDate. An invoice
 *      whose dueDate === today is NOT yet overdue — the member still has the
 *      full Bangkok-local business day to pay.
 */
export function deriveOverdue(
  invoice: Invoice,
  nowUtcIso: string,
): InvoiceWithOverdue {
  const isOverdue = computeIsOverdue(invoice, nowUtcIso);
  return { ...invoice, isOverdue };
}

/**
 * Same rules as `deriveOverdue` but without constructing the wrapper
 * object — used by `maybeEmitOverdueDetected` + tests that want the
 * boolean without the decoration cost.
 */
export function computeIsOverdue(
  invoice: Invoice,
  nowUtcIso: string,
): boolean {
  if (invoice.status !== 'issued') return false;
  if (invoice.dueDate === null) return false;
  const todayBkk = bangkokLocalDate(nowUtcIso);
  // YYYY-MM-DD strings compare lexicographically == chronologically.
  return todayBkk > invoice.dueDate;
}

/**
 * Opportunistic audit emit on first overdue detection per Bangkok-local
 * day. Returns `true` when a new audit row landed, `false` when a
 * prior detection already exists for today (duplicate suppressed by
 * the partial unique index).
 *
 * This function NEVER throws — an audit-write failure is logged by the
 * adapter but does not break the caller's read path. Audit emission
 * is a best-effort enrichment, not a correctness-critical step.
 */
export async function maybeEmitOverdueDetected(
  audit: OverdueAuditPort,
  invoice: Invoice,
  nowUtcIso: string,
  actor: { readonly userId: string; readonly requestId: string | null },
): Promise<boolean> {
  if (!computeIsOverdue(invoice, nowUtcIso)) return false;
  // 054-event-fee-invoices — the overdue-detected audit event is a member-
  // timeline surface keyed on a non-null member_id. Membership invoices
  // always carry one (`invoices_subject_fields_ck`); an event-fee invoice
  // (member_id NULL) is not a member-timeline subject, so skip the emit.
  if (invoice.memberId === null) return false;
  return audit.emitOverdueOnce({
    tenantId: invoice.tenantId,
    requestId: actor.requestId,
    actorUserId: actor.userId,
    invoiceId: invoice.invoiceId,
    memberId: invoice.memberId,
    // 088 FR-030 — an issued 088 bill has NULL §87 `documentNumber`; surface its
    // SC bill number so the overdue-detected audit isn't blank. Legacy §87 rows
    // keep documentNumber (billDocumentNumberRaw NULL → falls through).
    documentNumber: billFirstDocumentNumber(invoice),
    dueDate: invoice.dueDate ?? '',
    bangkokLocalDate: bangkokLocalDate(nowUtcIso),
  });
}
