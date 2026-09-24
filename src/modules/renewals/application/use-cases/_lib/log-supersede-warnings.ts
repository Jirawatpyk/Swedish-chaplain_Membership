/**
 * 106-void-on-reissue follow-up — the shared log for a renewal bridge issue
 * whose best-effort supersede-void failed.
 *
 * `issueMembershipBill` issues the new bill and then tries to void the
 * member's older unpaid bill. When that void fails, the member holds two
 * open bills until staff void the older one by hand. The
 * `invoicing_void_on_reissue_failed_total` metric counts it, but a metric
 * cannot say WHICH bill; this log does, one line per failure, under a
 * greppable errorId (`docs/runbooks/void-on-reissue.md`).
 *
 * Carries ids and the old bill's printed number only — no member PII.
 */
import { logger } from '@/lib/logger';
import type { SupersedeWarning } from '@/modules/invoicing';

export function logSupersedeWarnings(
  warnings: readonly SupersedeWarning[],
  context: {
    readonly errorId: string;
    readonly tenantId: string;
    readonly memberId: string;
    /** The NEW bill that was issued (and is valid regardless). */
    readonly invoiceId: string;
    readonly correlationId: string;
  },
): void {
  for (const warning of warnings) {
    logger.warn(
      {
        ...context,
        kind: warning.kind,
        ...(warning.kind === 'list_failed'
          ? {}
          : {
              supersededInvoiceId: warning.invoiceId,
              supersededBillNumber: warning.billDocumentNumber,
            }),
        ...(warning.kind === 'void_failed' ? { voidErrorCode: warning.errorCode } : {}),
      },
      '[renewals] older unpaid bill NOT auto-voided after reissue — void it manually',
    );
  }
}
