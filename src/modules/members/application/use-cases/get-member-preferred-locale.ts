/**
 * F3 use-case — read `members.preferred_locale` for a member (F7 R4 /
 * verify-fix Types-#6).
 *
 * Used by F7's `MembersBridgePort.getMemberPreferredLocale` so member
 * notifications (broadcast approved/rejected/cancelled/delivered/
 * failed-to-dispatch) honour per-member locale preference instead of
 * always falling back to tenant default.
 *
 * Returns `null` when:
 *   - the member's `preferred_locale` column is NULL (default for
 *     legacy rows + new members without an explicit preference)
 *   - the member is not found (caller falls back to tenant default
 *     either way; no separate "not found" surfaced because the
 *     fallback path is identical)
 *
 * The CHECK constraint on the column (migration 0082) guarantees
 * stored values are one of `en | th | sv` — no defensive parse
 * needed, but the return type is `'en' | 'th' | 'sv' | null` so
 * callers see the locale literal type directly.
 */
import { runInTenant } from '@/lib/db';
import { err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { MemberRepo, RepoError } from '../ports/member-repo';

export type GetMemberPreferredLocaleDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export type LocaleLiteral = 'en' | 'th' | 'sv';

export async function getMemberPreferredLocale(
  deps: GetMemberPreferredLocaleDeps,
  memberId: MemberId,
): Promise<Result<LocaleLiteral | null, RepoError>> {
  try {
    return await runInTenant(deps.tenant, async (tx) =>
      deps.memberRepo.findPreferredLocaleInTx(tx, memberId),
    );
  } catch (e) {
    return err({ code: 'repo.unexpected', cause: e });
  }
}
