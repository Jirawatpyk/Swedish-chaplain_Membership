/**
 * 108 PR-D (review cycle 10 — privacy B-1 / security HIGH-1) — which of a
 * batch of addresses belong to a LIVE contact that carries a marketing
 * opt-out (FR-022a).
 *
 * Used by F7's `MembersBridgePort.filterMarketingOptedOut` at dispatch, so a
 * contact switched off by staff or by themself is dropped from EVERY
 * segment (members, tier, attendees, custom list) — the opt-out is only
 * worth recording if the send path reads it.
 *
 * Contract:
 *   - an empty batch is answered without a query;
 *   - otherwise ONE batched repo read, tenant-scoped (RLS + explicit
 *     `tenant_id`), matched on `lower(email)`, removed rows ignored;
 *   - a repo failure is returned as-is — the bridge turns it into a
 *     rejection so the dispatcher retries rather than sending to people who
 *     objected (never fail-open).
 */
import { ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ContactRepo } from '../ports/contact-repo';
import type { RepoError } from '../ports/member-repo';

export type FilterMarketingOptedOutEmailsDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: Pick<ContactRepo, 'findMarketingOptedOutEmailLowers'>;
};

export async function filterMarketingOptedOutEmails(
  deps: FilterMarketingOptedOutEmailsDeps,
  emailLowers: ReadonlyArray<string>,
): Promise<Result<ReadonlySet<string>, RepoError>> {
  if (emailLowers.length === 0) return ok(new Set());
  return deps.contactRepo.findMarketingOptedOutEmailLowers(deps.tenant, emailLowers);
}
