/**
 * 126 (#5) — a plan's `member_type_scope` against the member's recorded
 * legal entity type.
 *
 * `Member` has no company/individual flag of its own; the closest recorded
 * fact is `legalEntityType`. Only `'individual'` is a natural person —
 * every other code, `sole_proprietor` included, is treated as a company
 * (a sole proprietorship is a business). `null` (10 of TSCC's 150 members
 * have no recorded type) is never inferred, so the check is skipped.
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { LegalEntityTypeCode } from '../value-objects/legal-entity-type';

export type MemberTypeScope = 'company' | 'individual' | 'both';

export type MemberTypeScopeViolation = {
  code: 'member_type.out_of_scope';
  legalEntityType: LegalEntityTypeCode;
  memberTypeScope: MemberTypeScope;
};

export function checkMemberTypeScope(
  legalEntityType: LegalEntityTypeCode | null,
  memberTypeScope: MemberTypeScope,
): Result<undefined, MemberTypeScopeViolation> {
  if (legalEntityType === null || memberTypeScope === 'both') return ok(undefined);
  const memberType = legalEntityType === 'individual' ? 'individual' : 'company';
  if (memberType === memberTypeScope) return ok(undefined);
  return err({ code: 'member_type.out_of_scope', legalEntityType, memberTypeScope });
}
