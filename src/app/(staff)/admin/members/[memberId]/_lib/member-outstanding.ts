/**
 * 122 US5b-1 (T552) — the member's outstanding balance for the detail page's
 * figures strip (Clarifications, Session 2026-09-29).
 *
 * The page's invoice list follows its own status filter, so it cannot answer
 * "what does this member owe". This asks the existing member invoice read for
 * issued invoices only — the one unpaid state: an invoice moves from issued to
 * paid or void, and a credit note only follows payment — up to 100, and sums
 * their totals. More than 100 is reported as partial (the sum is then a floor).
 * A failed or thrown read is "unavailable", never a zero the member would be
 * credited with.
 */
import { cache } from 'react';
import { listInvoicesByMember, makeListInvoicesByMemberDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';

/** The use case caps a page at 200; 100 mirrors the portal dashboard's read. */
const OUTSTANDING_PAGE_SIZE = 100;

export type MemberOutstanding =
  | {
      readonly state: 'ok';
      readonly sumSatang: bigint;
      /** Every unpaid invoice, including any beyond the 100 read. */
      readonly count: number;
      readonly earliestDueIso: string | null;
      readonly partial: boolean;
    }
  | { readonly state: 'unavailable' };

const UNAVAILABLE: MemberOutstanding = { state: 'unavailable' };

export const loadMemberOutstanding = cache(
  async (tenantId: string, memberId: string): Promise<MemberOutstanding> => {
    let res;
    try {
      res = await listInvoicesByMember(makeListInvoicesByMemberDeps(tenantId), {
        tenantId,
        memberId,
        status: 'issued',
        pageSize: OUTSTANDING_PAGE_SIZE,
        offset: 0,
      });
    } catch (e) {
      logger.warn(
        { event: 'member_outstanding_read_threw', memberId, errKind: errKind(e) },
        '[122 US5b] member outstanding read threw — strip shows unavailable',
      );
      return UNAVAILABLE;
    }
    if (!res.ok) {
      logger.warn(
        { event: 'member_outstanding_read_err', memberId },
        '[122 US5b] member outstanding read failed — strip shows unavailable',
      );
      return UNAVAILABLE;
    }
    const { rows, total } = res.value;
    let sumSatang = 0n;
    let earliestDueIso: string | null = null;
    for (const inv of rows) {
      sumSatang += inv.total?.satang ?? 0n;
      if (inv.dueDate !== null && (earliestDueIso === null || inv.dueDate < earliestDueIso)) {
        earliestDueIso = inv.dueDate;
      }
    }
    return { state: 'ok', sumSatang, count: total, earliestDueIso, partial: total > rows.length };
  },
);
