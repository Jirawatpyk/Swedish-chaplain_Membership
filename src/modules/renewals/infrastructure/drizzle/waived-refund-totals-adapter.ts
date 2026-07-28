/**
 * DV-Wave2 ⑥ — `WaivedRefundTotalsPort` adapter (Track B).
 *
 * The ONE place the renewals module reads F5. Goes through the payments PUBLIC
 * BARREL only (`listWaivedRefundTotalsByInvoice` + its deps factory) — no deep
 * import, no foreign table (Constitution Principle III). Verbatim mirror of
 * F9's `waived-refund-source-adapter.ts`.
 *
 * Barrel-cycle caveat (memory `066_barrel_cycle_breaks_tsx_scripts`): importing
 * the `@/modules/payments` barrel can cycle through `payments → server-only`.
 * This import is kept in THIS file only. If a tsx/script boundary ever breaks,
 * deep-import `list-waived-refund-totals-by-invoice` + its DI factory instead
 * of the barrel (the same escape F9-adjacent code uses).
 */
import {
  listWaivedRefundTotalsByInvoice,
  makeListWaivedRefundTotalsByInvoiceDeps,
} from '@/modules/payments';
import type { WaivedRefundTotalsPort } from '../../application/ports/waived-refund-totals-port';

export function makeWaivedRefundTotalsAdapter(
  tenantSlug: string,
): WaivedRefundTotalsPort {
  return {
    async sumWaivedByInvoice(tenantId) {
      const result = await listWaivedRefundTotalsByInvoice(
        makeListWaivedRefundTotalsByInvoiceDeps(tenantSlug),
        { tenantId },
      );
      // Throw rather than degrade to an empty map — an empty map is
      // indistinguishable from "no waived refunds exist", and silently
      // over-stating collected/settled is the exact bug this port removes
      // (F9's rationale). Failing the money band is the safe direction: the
      // page's best-effort wrapper renders nothing rather than a wrong number.
      //
      // Fix round 2 #8 — this branch is effectively DEAD today:
      // `ListWaivedRefundTotalsByInvoiceError` is `never` (the use-case can
      // only ever return `ok`), and a genuine DB/repo fault throws INSIDE
      // `listWaivedRefundTotalsByInvoice` — that throw propagates through
      // this `await` and is never caught here, so `result.ok` is `true`
      // whenever this line is even reached. Kept anyway: it is defensive-only
      // against a future widening of that error union, and it mirrors F9's
      // own `waived-refund-source-adapter.ts` verbatim (this adapter's stated
      // contract) for parity between the two call sites.
      if (!result.ok) {
        throw new Error('renewals: waived-refund total read failed');
      }
      return result.value;
    },
  };
}
