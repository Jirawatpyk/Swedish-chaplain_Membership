/**
 * T029 — F7 member-by-primary-email reverse lookup use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.lookupMemberPrimaryContactEmailInTenant`
 * (Phase 3+ T060). FR-015d resolution branch 1 — verify a custom-recipient
 * email matches the PRIMARY contact email of a member in the tenant.
 *
 * Returns `null` if no member has that primary email (caller decides
 * whether to fall through to branch 2 / branch 3 of the FR-015d
 * resolution chain or reject as `broadcast_custom_recipient_unknown`).
 */
import { runInTenant } from '@/lib/db';
import { err, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  F7MemberRecipient,
  MemberRepo,
  RepoError,
} from '../ports/member-repo';

export type LookupMemberPrimaryContactEmailInTenantDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: MemberRepo;
};

export async function lookupMemberPrimaryContactEmailInTenant(
  deps: LookupMemberPrimaryContactEmailInTenantDeps,
  emailLower: string,
): Promise<Result<F7MemberRecipient | null, RepoError>> {
  try {
    return await runInTenant(deps.tenant, async (tx) =>
      deps.memberRepo.findMemberByPrimaryContactEmailInTx(
        tx,
        emailLower.toLowerCase().trim(),
      ),
    );
  } catch (e) {
    return err({ code: 'repo.unexpected', cause: e });
  }
}
