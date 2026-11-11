/**
 * #89 — two slim member reads for the invoice pickers.
 *
 * - `memberPickerOptionsInTx`: the /admin/invoices/new preload. It selects only
 *   the four fields the picker shows (id, company, plan, plan year). It is the
 *   same set and order as the members directory's default page: the
 *   directory's own WHERE builder (not erased, the given statuses, every later
 *   directory exclusion) and last activity first, without the full member and
 *   primary-contact rows `directorySearch` reads (security INFO on #777). No
 *   statuses is no members (fail closed), never every status.
 * - `memberCompanyNamesByIdsInTx`: the invoices list's buyer-name fallback for
 *   rows without a frozen identity snapshot (drafts), read by id so it is not
 *   capped at the directory's first 100 members. Erased members are left out,
 *   as the directory read did; their rows keep the "—" placeholder.
 *
 * Both run inside the caller's `runInTenant` tx and carry an explicit
 * `tenant_id` predicate on top of RLS (D-029), like
 * `memberVatRegistrantByIdsInTx`.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { buildDirectoryWhere } from './drizzle-member-repo';
import { members } from './schema-members';

export type MemberPickerStatus = 'active' | 'inactive' | 'archived';

export interface MemberPickerRow {
  readonly memberId: string;
  readonly companyName: string;
  readonly planId: string;
  readonly planYear: number;
}

/** The directory read's own ceiling; the picker searches the server past it. */
const MAX_LIMIT = 100;

export async function memberPickerOptionsInTx(
  tx: TenantTx,
  tenantId: string,
  input: { readonly statuses: ReadonlyArray<MemberPickerStatus>; readonly limit: number },
): Promise<MemberPickerRow[]> {
  if (input.statuses.length === 0) return [];
  const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), MAX_LIMIT);
  const rows = await tx
    .select({
      memberId: members.memberId,
      companyName: members.companyName,
      planId: members.planId,
      planYear: members.planYear,
    })
    .from(members)
    .where(buildDirectoryWhere({ status: input.statuses, limit }, tenantId))
    .orderBy(sql`${members.lastActivityAt} DESC NULLS LAST`, asc(members.memberId))
    .limit(limit);
  return rows;
}

export async function memberCompanyNamesByIdsInTx(
  tx: TenantTx,
  tenantId: string,
  memberIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (memberIds.length === 0) return out;
  const rows = await tx
    .select({ memberId: members.memberId, companyName: members.companyName })
    .from(members)
    .where(
      and(
        eq(members.tenantId, tenantId),
        isNull(members.erasedAt),
        inArray(members.memberId, [...memberIds]),
      ),
    );
  for (const r of rows) out.set(r.memberId, r.companyName);
  return out;
}
