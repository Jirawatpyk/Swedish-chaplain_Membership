/**
 * Application port — Member repository.
 *
 * Infrastructure adapter (Drizzle) implements this; use cases depend on
 * this interface only (Clean Architecture, Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Member, MemberId } from '../../domain/member';
import type { Contact } from '../../domain/contact';

export type RepoError =
  | { code: 'repo.not_found' }
  | { code: 'repo.conflict'; reason: string }
  | { code: 'repo.unexpected'; cause?: unknown };

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
    patch: Partial<Member>,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<Member, RepoError>>;
}
