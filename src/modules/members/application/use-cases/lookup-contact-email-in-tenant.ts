/**
 * T029 — F7 contact email lookup use-case (F3 module).
 *
 * Used by F7's `MembersBridgePort.lookupContactEmailInTenant`
 * (Phase 3+ T060). FR-015d resolution branch 2 — verify a custom-recipient
 * email belongs to ANY contact (primary or secondary) in the tenant graph.
 *
 * Reuses F3's existing `ContactRepo.findByEmail` — no new repo method
 * needed. The use-case wraps the email validation + repo call.
 *
 * Returns `null` if no live contact in the tenant has that email
 * (case-insensitive match via `contacts_tenant_email_uniq` lower-index).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { asEmail } from '../../domain/value-objects/email';
import type { ContactRepo } from '../ports/contact-repo';
import type { RepoError } from '../ports/member-repo';

export type ContactEmailLookupResult = {
  readonly memberId: string;
  readonly contactId: string;
  readonly emailLower: string;
};

export type LookupContactEmailInTenantDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
};

export async function lookupContactEmailInTenant(
  deps: LookupContactEmailInTenantDeps,
  emailLower: string,
): Promise<Result<ContactEmailLookupResult | null, RepoError>> {
  // Convert raw lowercase string to F3's branded Email VO (re-validates
  // format; rejects malformed input as a clean repo.not_found semantic).
  const emailResult = asEmail(emailLower);
  if (!emailResult.ok) {
    return ok(null);
  }
  const repoResult = await deps.contactRepo.findByEmail(
    deps.tenant,
    emailResult.value,
  );
  if (!repoResult.ok) {
    if (repoResult.error.code === 'repo.not_found') {
      return ok(null);
    }
    return err(repoResult.error);
  }
  const contact = repoResult.value;
  return ok({
    memberId: contact.memberId,
    contactId: contact.contactId,
    emailLower: contact.email.toLowerCase(),
  });
}
