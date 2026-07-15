/**
 * Batched member VAT-REGISTRANT lookup.
 *
 * Backs the F6 admin event-detail endpoint's `buyerIsVatRegistrant` enrichment
 * (the attendee picker on /admin/invoices/new needs server-truth registrant
 * status for MATCHED members, so the issuance-mode rules it offers agree with
 * what issuance will actually decide — bill_first disabled etc.).
 *
 * 059 / PR-A Task 6c — this REPLACES the 064-remediation-B5 `buyerHasTin`
 * lookup (`member-tin-presence.ts`). The picker used to ask "does this member
 * have a non-blank tax_id?", which is the question issuance used to ask too.
 * Task 6a re-keyed the server's `event_no_tin_requires_paid_issue` gate onto
 * the RECORDED `members.is_vat_registered` flag — because a foreign member may
 * now store a passport / work-permit number in `tax_id`, and "this text field
 * is non-blank" is not "this buyer is a ผู้ประกอบการจดทะเบียน". Leaving the
 * picker on TIN-presence left the two disagreeing: a TIN-bearing NON-registrant
 * was offered `bill_first`, then rejected at issue with "this buyer has no tax
 * ID" — while visibly having one.
 *
 * Consumed via the cross-module composition pattern established by
 * `countActiveMembersOnPlanInTx` / F6's `findByIds` batch lookup: a free
 * Infrastructure function re-exported through the members barrel, called from
 * the `src/lib/**` composition root with the caller's OWN `runInTenant` tx so
 * the read runs under `SET LOCAL app.current_tenant` (Principle I — cross-tenant
 * member ids are invisible: RLS hides their rows, so they are simply ABSENT
 * from the returned map, never leaked).
 *
 * PRIVACY: only the BOOLEAN leaves this function. It never selected the raw
 * tax-id, and now it does not even read it — the registrant flag is a business
 * fact, not PII, and the picker has no use for the number.
 *
 * INFRASTRUCTURE layer by design (raw Drizzle query — same S1-P0-3 placement
 * rationale as `count-active-members-on-plan.ts`).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { members } from './schema-members';

/**
 * Map of memberId → `members.is_vat_registered` for the given ids, read INSIDE
 * an existing `TenantTx`. Ids not found (or RLS-hidden) are absent from the map.
 *
 * The column is `NOT NULL DEFAULT false`, so the boolean is always a recorded
 * fact — never inferred, and never `null`. All member statuses are included:
 * issuance has its own archived-member guard, and the picker only needs the
 * registrant signal.
 *
 * The explicit `tenant_id` filter is defence-in-depth on top of RLS (same
 * posture as the F4/F5 repos).
 */
export async function memberVatRegistrantByIdsInTx(
  tx: TenantTx,
  tenantId: string,
  memberIds: ReadonlyArray<string>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (memberIds.length === 0) return out;
  const rows = await tx
    .select({
      memberId: members.memberId,
      isVatRegistered: members.isVatRegistered,
    })
    .from(members)
    .where(
      and(
        eq(members.tenantId, tenantId),
        inArray(members.memberId, [...memberIds]),
      ),
    );
  for (const r of rows) {
    out.set(r.memberId, r.isVatRegistered);
  }
  return out;
}
