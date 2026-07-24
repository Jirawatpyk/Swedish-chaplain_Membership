/**
 * Void-invoice → renewal-cycle unlink (Phase 2, Step 2.4) — renewals adapter for
 * the INVOICING-owned `onMembershipInvoiceVoidedInTx` void seam.
 *
 * When an admin VOIDs a membership §86/4, the `renewal_cycles.linked_invoice_id`
 * that pointed at it must be cleared: the voided invoice no longer validly links
 * the cycle, and a subsequent re-issue (void the §86/4 + reissue so the new plan
 * applies now) would otherwise hit `InvoiceLinkConflictError` from `linkInvoice`'s
 * `WHERE linked_invoice_id IS NULL OR = $new` guard.
 *
 * Runs on the void's Phase-1 tx (threaded, never a nested `runInTenant`) so the
 * clear commits ATOMICALLY with the void + the `invoice_voided` audit, and never
 * opens a second pooled connection while the void holds the member-row lock — the
 * void's `invoice_voided` audit fires the members `last_activity_at` trigger,
 * which locks the member row on this SAME tx; the clear touches only
 * `renewal_cycles`, so there is no member-row contention → no deadlock.
 *
 * NOT gated on FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE — a voided invoice never
 * validly links a cycle regardless of that flag. (The void route only wires this
 * seam when FEATURE_F8_RENEWALS is on; with F8 off there are no renewal_cycles to
 * unlink, so the seam is simply absent.)
 *
 * Pure Infrastructure — imports only within the renewals module (Constitution
 * Principle III). The invoicing contract is a plain closure shape (no F4 import);
 * the dependency arrow points renewals → invoicing.
 */
import { asTenantContext } from '@/modules/tenants';
import { isTenantTx } from '@/lib/db';
import { makeDrizzleRenewalCycleRepo } from '../drizzle/drizzle-renewal-cycle-repo';

/**
 * @param tenantId - tenant slug the unlink closure is bound to.
 * @returns the `onMembershipInvoiceVoidedInTx` closure `voidInvoice` invokes
 *   inside its Phase-1 tx for a MEMBERSHIP void.
 */
export function makeVoidInvoiceCycleUnlink(
  tenantId: string,
): (
  tx: unknown,
  args: { readonly tenantId: string; readonly invoiceId: string },
) => Promise<void> {
  const cyclesRepo = makeDrizzleRenewalCycleRepo(asTenantContext(tenantId));
  return async (tx, args) => {
    // Belt-and-suspenders: the void threads its real Phase-1 TenantTx (opened
    // via the invoice repo's withTx → runInTenant, so app.current_tenant is
    // SET LOCAL). A non-TenantTx here would corrupt tenant scope / drop RLS —
    // THROW so the void tx rolls back rather than silently mis-scoping the
    // clear (never a fallback runInTenant, which would open a second
    // connection while the void holds the member-row lock).
    if (!isTenantTx(tx)) {
      throw new Error(
        'makeVoidInvoiceCycleUnlink: void threaded a non-TenantTx — refusing to run',
      );
    }
    const cycle = await cyclesRepo.findByInvoiceIdInTx(
      tx,
      args.tenantId,
      args.invoiceId,
    );
    // No cycle links this invoice (e.g. an ad-hoc admin invoice, or the §86/4
    // never reached a renewal cycle) → nothing to clear.
    if (cycle === null) return;
    // `false` (0 rows) is a benign no-op: the cycle raced out of an OPEN status
    // (e.g. its payment just landed → completed), was re-linked to a different
    // invoice, or is already unlinked. The void proceeds either way. A genuine
    // infra failure THROWS from the repo → the void tx rolls back.
    await cyclesRepo.clearLinkedInvoiceForVoidInTx(
      tx,
      args.tenantId,
      cycle.cycleId,
      args.invoiceId,
    );
  };
}
