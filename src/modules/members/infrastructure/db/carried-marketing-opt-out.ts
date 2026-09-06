/**
 * 108 PR-D — a contact's OWN marketing objection follows the ADDRESS, not the row.
 *
 * A `self` opt-out is the same objection as the unsubscribe link (FR-025
 * AMENDMENT, GDPR Art. 21(3)), but it is stored on the `contacts` row. Removing
 * the person and adding the same address back would otherwise restore marketing
 * silently — the shape SweCham's pending secondary-contact import has. A
 * `staff` opt-out is an operational setting on a row, not the person's
 * objection, so it does NOT follow.
 *
 * Two corrections from the staff-review gate live here:
 *
 * 1. **Every insert path uses it** (finding C1). The first version guarded only
 *    `drizzleContactRepo.addInTx`. `createWithPrimaryContactInTx` (i.e. every
 *    `POST /api/members`) and `scripts/import-members.ts` wrote contacts
 *    without it, so the objection was lost on exactly the paths the fix was
 *    written for. This module is the one place that answers the question.
 *
 * 2. **The LATEST row for the address decides** (finding C2), not the latest
 *    row that happens to carry an objection. Ordering by
 *    `marketing_opt_out_at DESC` over rows filtered to `source='self'` meant a
 *    person who opted out, changed their mind, and was later re-added had the
 *    withdrawn objection resurrected from a long-removed row — silently
 *    discarding their own opt-in (FR-032). Ordering by `created_at DESC` and
 *    reading whatever that row says is correct because
 *    `contacts_tenant_email_uniq (tenant_id, lower(email)) WHERE removed_at IS
 *    NULL` guarantees the previous row was removed before the next one existed.
 *
 * Caller contract: run inside the SAME transaction as the INSERT. There is no
 * row to lock (the new row does not exist yet), so a `self` "on" committing
 * between this read and the insert would still be missed — that window is
 * bounded by the transaction and is the same window the repo's own
 * `setMarketingOptOutInTx` closes for updates.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { contacts } from './schema-contacts';

export interface CarriedMarketingOptOut {
  readonly marketingOptOutAt: Date;
  readonly marketingOptOutSource: 'self';
  readonly marketingOptOutByUserId: string | null;
}

/**
 * The marketing columns a new row for `email` must be born with, or `null` when
 * it starts in `RECEIVES_MARKETING`. Spread the result straight into the
 * INSERT values.
 */
export async function findCarriedSelfOptOut(
  tx: TenantTx,
  tenantId: string,
  email: string,
): Promise<CarriedMarketingOptOut | null> {
  const prior = await tx
    .select({
      at: contacts.marketingOptOutAt,
      source: contacts.marketingOptOutSource,
      byUserId: contacts.marketingOptOutByUserId,
    })
    .from(contacts)
    .where(
      and(eq(contacts.tenantId, tenantId), sql`lower(${contacts.email}) = lower(${email})`),
    )
    .orderBy(desc(contacts.createdAt))
    .limit(1);

  const latest = prior[0];
  if (latest === undefined || latest.source !== 'self' || latest.at === null) return null;
  return {
    marketingOptOutAt: latest.at,
    marketingOptOutSource: 'self',
    marketingOptOutByUserId: latest.byUserId,
  };
}
