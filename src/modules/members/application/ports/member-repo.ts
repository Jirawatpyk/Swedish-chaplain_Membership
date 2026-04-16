/**
 * Application port — Member repository.
 *
 * Infrastructure adapter (Drizzle) implements this; use cases depend on
 * this interface only (Clean Architecture, Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Member, MemberId, PlanId } from '../../domain/member';
import type { Contact } from '../../domain/contact';
import type { IsoCountryCode } from '../../domain/value-objects/iso-country-code';
import type { TaxId } from '../../domain/value-objects/tax-id';

export type RepoError =
  | { code: 'repo.not_found' }
  | { code: 'repo.conflict'; reason: string }
  | { code: 'repo.unexpected'; cause?: unknown };

/**
 * Narrowed patch type for `updateFields` — only fields that are safe
 * to mutate via a partial update. Identity fields (`tenantId`, `memberId`,
 * `createdAt`, etc.) are intentionally excluded so callers cannot
 * accidentally pass them and have them silently ignored.
 */
export type MemberPatch = Partial<
  Pick<
    Member,
    | 'companyName'
    | 'legalEntityType'
    | 'website'
    | 'description'
    | 'notes'
    | 'foundedYear'
    | 'turnoverThb'
  > & {
    country: IsoCountryCode;
    taxId: TaxId | null;
    planId: PlanId;
    planYear: number;
  }
>;

export interface MemberRepo {
  findById(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<Result<Member, RepoError>>;

  findSoftDuplicate(
    ctx: TenantContext,
    companyName: string,
    country: string,
  ): Promise<Result<Member | null, RepoError>>;

  /**
   * Transactional create: inserts the Member, its first primary Contact,
   * and the matching `member_created` audit row in one DB transaction.
   * Returns the persisted Member + Contact (with DB-generated timestamps).
   */
  createWithPrimaryContact(
    ctx: TenantContext,
    draft: {
      readonly member: Omit<Member, 'createdAt' | 'updatedAt'>;
      readonly primaryContact: Omit<
        Contact,
        'createdAt' | 'updatedAt' | 'memberId'
      >;
    },
    actorUserId: string,
    requestId: string,
  ): Promise<Result<{ member: Member; contact: Contact }, RepoError>>;

  updateStatus(
    ctx: TenantContext,
    memberId: MemberId,
    next: Member,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<Member, RepoError>>;

  updateFields(
    ctx: TenantContext,
    memberId: MemberId,
    patch: MemberPatch,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<Member, RepoError>>;
}
