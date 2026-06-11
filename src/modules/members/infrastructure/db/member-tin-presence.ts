/**
 * 064 remediation B5 — batched member tax-id PRESENCE lookup.
 *
 * Backs the F6 admin event-detail endpoint's `buyerHasTin` enrichment
 * (the attendee picker on /admin/invoices/new needs server-truth TIN
 * presence for MATCHED members instead of the legacy "matched ⇒ has TIN"
 * client guess, so a TIN-less matched member gets the correct no-TIN
 * issuance-mode rules — bill_first disabled etc.).
 *
 * Consumed via the cross-module composition pattern established by
 * `countActiveMembersOnPlanInTx` above / F6's `findByIds` batch lookup:
 * a free Infrastructure function re-exported through the members barrel,
 * called from the `src/lib/**` composition root with the caller's OWN
 * `runInTenant` tx so the read runs under `SET LOCAL app.current_tenant`
 * (Principle I — cross-tenant member ids are invisible: RLS hides their
 * rows, so they are simply ABSENT from the returned map, never leaked).
 *
 * PRIVACY: only PRESENCE (a boolean) leaves this function — the raw
 * tax-id value is PII on the wire and the picker has no use for it.
 *
 * INFRASTRUCTURE layer by design (raw Drizzle query — same S1-P0-3
 * placement rationale as `count-active-members-on-plan.ts`).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { members } from './schema-members';

/**
 * Map of memberId → "has a non-blank tax id" for the given ids, read
 * INSIDE an existing `TenantTx`. Ids not found (or RLS-hidden) are absent
 * from the map. Presence semantics mirror the F4 Domain `buyerHasTin`
 * (trimmed non-empty), so the picker's preview agrees with what issuance
 * will decide. All member statuses are included — issuance has its own
 * archived-member guard and the picker only needs the TIN signal.
 *
 * The explicit `tenant_id` filter is defence-in-depth on top of RLS
 * (same posture as the F4/F5 repos).
 */
export async function memberTinPresenceByIdsInTx(
  tx: TenantTx,
  tenantId: string,
  memberIds: ReadonlyArray<string>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (memberIds.length === 0) return out;
  const rows = await tx
    .select({ memberId: members.memberId, taxId: members.taxId })
    .from(members)
    .where(
      and(
        eq(members.tenantId, tenantId),
        inArray(members.memberId, [...memberIds]),
      ),
    );
  for (const r of rows) {
    out.set(r.memberId, r.taxId !== null && r.taxId.trim().length > 0);
  }
  return out;
}
