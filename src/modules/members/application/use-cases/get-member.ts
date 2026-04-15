/**
 * `get-member` use case (T068 API path).
 *
 * Returns the member + its contacts, or a 404 + audit on cross-tenant probe
 * (FR-022). The repo SELECT returns zero rows when the id belongs to another
 * tenant (RLS), so we cannot distinguish "doesn't exist" from "wrong tenant"
 * — we emit `member_cross_tenant_probe` unconditionally on miss, because
 * any miss from an authenticated admin is interesting (spec plan.md §
 * Constraints: "for member PII any probe is high-signal").
 */

import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Member, MemberId } from '../../domain/member';
import type { Contact } from '../../domain/contact';
import type { MemberRepo } from '../ports/member-repo';
import type { ContactRepo } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';

export type GetMemberError =
  | { type: 'not_found' }
  | { type: 'server_error'; message: string };

export type GetMemberDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  contactRepo: ContactRepo;
  audit: AuditPort;
};

export type GetMemberCallMeta = {
  actorUserId: string;
  requestId: string;
};

export async function getMember(
  memberId: MemberId,
  meta: GetMemberCallMeta,
  deps: GetMemberDeps,
): Promise<
  Result<{ member: Member; contacts: Contact[] }, GetMemberError>
> {
  const member = await deps.memberRepo.findById(deps.tenant, memberId);
  if (!member.ok) {
    if (member.error.code === 'repo.not_found') {
      // Any miss gets an audit row — cross-tenant probes are high-signal
      // for PII resources (per plan.md § Constraints).
      await deps.audit.record(deps.tenant, {
        type: 'member_cross_tenant_probe',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `probe on ${memberId}`,
        payload: {
          attempted_member_id: memberId,
          actor_tenant_id: deps.tenant.slug,
        },
      });
      return err({ type: 'not_found' });
    }
    return err({
      type: 'server_error',
      message: `member: ${member.error.code}`,
    });
  }

  const contactsResult = await deps.contactRepo.listByMember(
    deps.tenant,
    memberId,
  );
  if (!contactsResult.ok) {
    return err({
      type: 'server_error',
      message: `contacts: ${contactsResult.error.code}`,
    });
  }

  return ok({ member: member.value, contacts: contactsResult.value });
}
