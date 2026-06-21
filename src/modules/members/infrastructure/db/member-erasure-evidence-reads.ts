/**
 * COMP-1 US3-D — data-resolution reads for the DPO erasure-evidence log.
 *
 * Two barrel-exported free functions backing the read-only admin
 * "erasure evidence" page (the use-case in US3-D Task 3 consumes them):
 *
 *   - `listMemberLinkedUserIds` — the member's linked-login user ids, used to
 *     bind the tenant-NULL `user_erased` evidence arm to a specific member.
 *     Delegates to the UNFILTERED `listAllLinkedUserIdsForMemberInTx` so it
 *     surfaces logins on contact rows the erasure scrub already removed_at-
 *     stamped (the scrub preserves `linked_user_id`). Returns `[]` for a
 *     member with no linked logins.
 *
 *   - `listErasedMembers` — keyset-paginated list of the tenant's erased
 *     members (`erased_at IS NOT NULL`), newest-erasure-first, the page's
 *     top-level list. Mirrors the `audit-query-repo.ts` keyset idiom
 *     (`(erased_at DESC, member_id DESC)` with an offset-free cursor).
 *
 * Free functions (NOT MemberRepo methods) — the established narrow-read
 * pattern (`getMemberErasureStatus` / `countActiveMembersOnPlan` /
 * `memberTinPresenceByIdsInTx`) avoids widening the MemberRepo interface +
 * its many test stubs.
 *
 * RLS (Principle I): both reads thread the `runInTenant` tx, never the global
 * `db` singleton. `members` and `contacts` are RLS-scoped, so every predicate
 * resolves only the current tenant's rows. The keyset list orders the
 * partial `members_erased_at_idx` (migration 0226) range scan.
 *
 * FAIL-CLOSED BY DESIGN — no try/catch. A read failure must REJECT the page
 * render (→ the admin segment `error.tsx` boundary), NOT default to a value.
 * Defaulting to "no evidence" would understate the erasure-evidence log — a
 * DPO/Art.30 accountability gap.
 */
import { and, desc, eq, isNotNull, lt, or, type SQL } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { drizzleContactRepo } from './drizzle-contact-repo';
import { members } from './schema-members';
import type { MemberId } from '../../domain/member';

/**
 * The member's linked-login user ids (UNFILTERED — includes logins on
 * removed_at-stamped contact rows so post-erasure evidence binding still
 * resolves them). `[]` ⇔ the member never had a linked portal login.
 */
export async function listMemberLinkedUserIds(
  ctx: TenantContext,
  memberId: MemberId,
): Promise<readonly string[]> {
  return runInTenant(ctx, (tx) =>
    drizzleContactRepo.listAllLinkedUserIdsForMemberInTx(tx, memberId),
  );
}

/** One row of the erased-members list — the evidence page's top-level entry. */
export type ErasedMemberRow = {
  readonly memberId: string;
  readonly memberNumber: number;
  readonly erasedAt: Date;
};

/**
 * Keyset cursor for "load more". Carries the full `(erased_at, member_id)`
 * sort key of the last row on the current page; the next call resolves rows
 * strictly "older" than it. `null` ⇔ no further page.
 */
export type ErasedMembersCursor = {
  readonly erasedAt: Date;
  readonly memberId: string;
};

export type ListErasedMembersInput = {
  readonly limit: number;
  readonly cursor?: ErasedMembersCursor;
};

export type ListErasedMembersResult = {
  readonly rows: readonly ErasedMemberRow[];
  /** Cursor for the next page, or `null` when the last page was returned. */
  readonly nextCursor: ErasedMembersCursor | null;
};

/**
 * Keyset-paginated list of the tenant's erased members, newest-erasure-first.
 *
 * Ordered `(erased_at DESC, member_id DESC)` — the same `(sort-col DESC,
 * pk DESC)` keyset shape as `audit-query-repo.ts`. The cursor predicate
 * `(erased_at < c.erasedAt) OR (erased_at = c.erasedAt AND member_id <
 * c.memberId)` is an offset-free scan that stays O(page) however deep the
 * operator paginates. `nextCursor` is non-null iff a full page was returned
 * (i.e. there may be more); the caller stops when it comes back `null`.
 *
 * `erased_at IS NOT NULL` is range-scanned via the partial
 * `members_erased_at_idx`. Tenant-scoped via `runInTenant` (RLS) — `members`
 * is a tenant-scoped table; the tx is threaded, never the global `db`.
 */
export async function listErasedMembers(
  ctx: TenantContext,
  { limit, cursor }: ListErasedMembersInput,
): Promise<ListErasedMembersResult> {
  return runInTenant(ctx, async (tx) => {
    const conds: SQL[] = [isNotNull(members.erasedAt)];
    if (cursor) {
      // Rows strictly "older" than the cursor in `(erased_at DESC, member_id
      // DESC)` order: (erased_at < c.erased_at) OR (erased_at = c.erased_at
      // AND member_id < c.member_id). The `eq` arm is the same-timestamp
      // tie-break on the member_id pk so two members erased in the same
      // instant never straddle (or duplicate across) a page boundary.
      const keyset = or(
        lt(members.erasedAt, cursor.erasedAt),
        and(
          eq(members.erasedAt, cursor.erasedAt),
          lt(members.memberId, cursor.memberId),
        ),
      );
      if (keyset) conds.push(keyset);
    }

    const rows = await tx
      .select({
        memberId: members.memberId,
        memberNumber: members.memberNumber,
        erasedAt: members.erasedAt,
      })
      .from(members)
      .where(and(...conds))
      .orderBy(desc(members.erasedAt), desc(members.memberId))
      .limit(limit);

    const mapped: ErasedMemberRow[] = rows.map((r) => ({
      memberId: r.memberId,
      memberNumber: r.memberNumber,
      // erased_at is non-null by the WHERE predicate; assert for the type.
      erasedAt: r.erasedAt as Date,
    }));

    const last = mapped.length === limit ? mapped[mapped.length - 1] : undefined;
    const nextCursor =
      last === undefined
        ? null
        : { erasedAt: last.erasedAt, memberId: last.memberId };

    return { rows: mapped, nextCursor };
  });
}
