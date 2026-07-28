/**
 * DV-Wave2 ⑥ — the ONE place the renewals module reads F5 waived refunds
 * (Track B). Mirrors F9's `WaivedRefundSource` port exactly.
 *
 * WHY THIS EXISTS. Task 6's money legs net refunded money out of collected /
 * settled totals. Credit-note refunds already move `invoices.credited_total_
 * satang`; a WAIVED refund (the invoice was voided, or the buyer holds a §105
 * ใบเสร็จรับเงิน) writes nothing there and leaves the invoice `paid` at full
 * value after the cash has gone back. Without subtracting this map, the
 * "Collected this month" + "Settled" legs overstate by the refunded amount —
 * the exact overstatement the 2026-07-28 F9 forward-check flagged.
 *
 * Per-invoice totals in satang; invoices with no waived refund are ABSENT
 * (the caller defaults with `?? 0n`). The concrete adapter is the ONLY
 * renewals file that imports `@/modules/payments` (Constitution Principle III).
 */
export interface WaivedRefundTotalsPort {
  sumWaivedByInvoice(tenantId: string): Promise<ReadonlyMap<string, bigint>>;
}
