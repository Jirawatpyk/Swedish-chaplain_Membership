/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b) — server-side read
 * resolving a member's renewal-payment classification for the New-invoice
 * form's advisory context line + duplicate-billing warning.
 *
 * Presentation orchestrates BOTH the F8 (renewals) and F4 (invoicing)
 * public barrels here (Constitution Principle III — cross-context reads go
 * through public barrels only; F4 itself never imports F8). Consumed by:
 *   - `GET /api/invoices/member-renewal-context` (client-side fetch, driven
 *     by the New-invoice form's member picker);
 *   - `POST /api/invoices` (Task 9 review-mandate — the SAME classification
 *     drives the server-authoritative `membershipCoverage` window threaded
 *     into `createInvoiceDraft`, never a client-supplied value).
 *
 * Advisory only (design §3b: "Server remains authoritative — the hook
 * re-derives at payment time") — this read informs the printed §86/4
 * coverage text and the admin-facing hint copy; it does NOT itself mutate
 * any renewal state. A read failure (bad memberId, transient DB error)
 * degrades to the neutral `heal_no_cycle`-shaped fallback rather than
 * blocking invoice creation.
 */
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import {
  classifyMembershipPayment,
  makeRenewalsDeps,
  type MembershipPaymentClassification,
} from '@/modules/renewals';
import { listInvoicesByMember, makeListInvoicesByMemberDeps } from '@/modules/invoicing';

export interface MemberRenewalContext {
  readonly classification: MembershipPaymentClassification;
  /** Only set when `classification.kind === 'renewal'` (the member's open cycle's current period end). */
  readonly periodTo: string | null;
  /** Only set when `classification.kind === 'renewal'` (the open cycle's frozen plan term). */
  readonly termMonths: number | null;
  /** An existing `status='issued'` (unpaid) membership invoice for this member. */
  readonly hasUnpaidMembershipInvoice: boolean;
}

// Advisory-only unpaid-invoice peek (see module docstring) — a member very
// rarely accumulates more than a handful of ISSUED membership invoices at
// once (annual billing), so a single capped page is sufficient without a
// pagination loop.
const UNPAID_CHECK_PAGE_SIZE = 50;

/**
 * Given a memberId, resolves the same `classifyMembershipPayment` shape
 * every other settlement site consumes (the unlinked-invoice on-paid hook,
 * `markCycleCompleteInTx`, `mark-paid-offline`) — see
 * `src/modules/renewals/domain/classify-membership-payment.ts`.
 */
export async function loadMemberRenewalContext(
  tenantSlug: string,
  memberId: string,
): Promise<MemberRenewalContext> {
  const ctx = asTenantContext(tenantSlug);
  const renewalsDeps = makeRenewalsDeps(tenantSlug);

  const { classification, periodTo, termMonths } = await runInTenant(
    ctx,
    async (tx) => {
      const guards = await renewalsDeps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
        tx,
        tenantSlug,
        memberId,
      );
      const memberErased = guards?.erased === true;

      const cycleCountForMember = await renewalsDeps.cyclesRepo.countCyclesForMemberInTx(
        tx,
        tenantSlug,
        memberId,
      );
      const openCycle = await renewalsDeps.cyclesRepo.findOpenCycleForMemberInTx(
        tx,
        tenantSlug,
        memberId,
      );
      // F2 fix (final-review, 2026-07-09) — SETTLED history (completed OR
      // ever-anchored), not raw cycle count, discriminates first_payment
      // vs renewal (see classify-membership-payment.ts docstring). Only
      // queried when an open cycle exists.
      const settledCycleCountForMember = openCycle
        ? await renewalsDeps.cyclesRepo.countSettledCyclesForMemberInTx(
            tx,
            tenantSlug,
            memberId,
            openCycle.cycleId,
          )
        : 0;

      const classification = classifyMembershipPayment({
        cycleCountForMember,
        settledCycleCountForMember,
        openCycle: openCycle
          ? {
              // Vestigial 'reminded' status folds into 'upcoming' — mirrors
              // every other classifier caller (see domain docstring).
              status: openCycle.status === 'awaiting_payment' ? 'awaiting_payment' : 'upcoming',
              anchoredAt: openCycle.anchoredAt,
            }
          : null,
        memberErased,
      });

      return {
        classification,
        periodTo: classification.kind === 'renewal' ? (openCycle?.periodTo ?? null) : null,
        termMonths:
          classification.kind === 'renewal' ? (openCycle?.frozenPlanTermMonths ?? null) : null,
      };
    },
  );

  // Unpaid-membership-invoice peek — a different module's repo (invoicing),
  // so it runs OUTSIDE the renewals tx above (its own `runInTenant`, per
  // `listInvoicesByMember`'s Drizzle adapter).
  const invoicesResult = await listInvoicesByMember(makeListInvoicesByMemberDeps(tenantSlug), {
    tenantId: tenantSlug,
    memberId,
    status: 'issued',
    pageSize: UNPAID_CHECK_PAGE_SIZE,
    offset: 0,
  });
  const hasUnpaidMembershipInvoice =
    invoicesResult.ok &&
    invoicesResult.value.rows.some((invoice) => invoice.invoiceSubject === 'membership');

  return { classification, periodTo, termMonths, hasUnpaidMembershipInvoice };
}
