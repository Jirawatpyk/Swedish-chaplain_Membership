/**
 * F9 `WaivedRefundSource` adapter (Track B).
 *
 * The ONE place the insights module reads F5. Goes through the payments PUBLIC
 * BARREL only (`listWaivedRefundTotalsByInvoice` + its deps factory) — no
 * deep import, no foreign table (Constitution Principle III).
 *
 * WHY THIS EXISTS. F9 nets refunded money out of revenue via
 * `invoices.credited_total_satang`, which only a §86/10 credit note updates. A
 * refund that legitimately owes no credit note — the invoice was voided, or the
 * buyer holds a §105 ใบเสร็จรับเงิน — writes nothing there and does not change
 * the invoice status. A §105 invoice therefore stays `paid` at full value after
 * the cash has gone back, and every revenue figure overstates by that amount
 * until this map is subtracted.
 *
 * Deliberately NOT filtered by waiver reason. Of the two grounds only
 * `section_105_receipt` can overstate — an `invoice_voided` waiver leaves the
 * invoice `void`, which the consumer's paid-revenue status filter already
 * excludes. Encoding that judgement here as well would put the same rule in two
 * places, and the consumer's filter is the one that actually runs.
 */
import {
  listWaivedRefundTotalsByInvoice,
  makeListWaivedRefundTotalsByInvoiceDeps,
} from '@/modules/payments';
import type { TenantContext } from '@/modules/tenants';
import type { WaivedRefundSource, WaivedRefundTotals } from '../../application/ports/source-ports';

export const waivedRefundSourceAdapter: WaivedRefundSource = {
  async sumWaivedByInvoice(ctx: TenantContext): Promise<WaivedRefundTotals> {
    const result = await listWaivedRefundTotalsByInvoice(
      makeListWaivedRefundTotalsByInvoiceDeps(ctx.slug),
      { tenantId: ctx.slug },
    );
    // Throw rather than degrade to an empty map. An empty map is
    // indistinguishable from "no waived refunds exist", and silently publishing
    // revenue computed as if none had ever happened is the exact overstatement
    // this adapter was added to remove. Failing the snapshot is the safe
    // direction: the previous snapshot stays visible and the cron retries.
    if (!result.ok) {
      throw new Error('WaivedRefundSource: waived-refund total read failed');
    }
    return result.value;
  },
};
