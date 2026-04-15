/**
 * Application port — Contact repository.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Contact, ContactId } from '../../domain/contact';
import type { MemberId } from '../../domain/member';
import type { RepoError } from './member-repo';

export interface ContactRepo {
  listByMember(
    ctx: TenantContext,
    memberId: MemberId,
    options?: { readonly includeRemoved?: boolean },
  ): Promise<Result<Contact[], RepoError>>;

  findById(
    ctx: TenantContext,
    contactId: ContactId,
  ): Promise<Result<Contact, RepoError>>;

  add(
    ctx: TenantContext,
    draft: Omit<Contact, 'createdAt' | 'updatedAt'>,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<Contact, RepoError>>;

  update(
    ctx: TenantContext,
    contactId: ContactId,
    patch: Partial<Contact>,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<Contact, RepoError>>;

  /**
   * Soft-delete (`removedAt = now`). A primary contact cannot be removed
   * while still primary — caller must `promotePrimary` first.
   */
  remove(
    ctx: TenantContext,
    contactId: ContactId,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<Contact, RepoError>>;

  /**
   * Demote the current primary + promote the target in one transaction.
   * Maps the partial-index race condition to `repo.conflict`.
   */
  promotePrimary(
    ctx: TenantContext,
    memberId: MemberId,
    newPrimaryContactId: ContactId,
    actorUserId: string,
    requestId: string,
  ): Promise<Result<{ demoted: Contact; promoted: Contact }, RepoError>>;
}
