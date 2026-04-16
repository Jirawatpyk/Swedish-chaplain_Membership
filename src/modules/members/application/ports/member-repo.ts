/**
 * Application port — Member repository.
 *
 * Infrastructure adapter (Drizzle) implements this; use cases depend on
 * this interface only (Clean Architecture, Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Member, MemberId, PlanId } from '../../domain/member';
import type { Contact } from '../../domain/contact';
import type { IsoCountryCode } from '../../domain/value-objects/iso-country-code';
import type { TaxId } from '../../domain/value-objects/tax-id';

// --- Directory search types (US2) -------------------------------------------

export type DirectoryFilter = {
  readonly q?: string;
  readonly status?: readonly ('active' | 'inactive' | 'archived')[];
  readonly planYear?: number;
  readonly country?: string;
  readonly planId?: string;
  readonly limit: number;
  readonly cursor?: string;
};

export type DirectoryRow = {
  readonly member: Member;
  readonly primaryContact: Contact | null;
  readonly planDisplayName: string | null;
};

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

  /**
   * Persist a status-transition snapshot. Caller is responsible for
   * emitting `member_status_changed` / `member_archived` / `member_undeleted`
   * audit events via AuditPort — the repo only writes the row. Archive/
   * activate use cases will wire this up in US4 (not shipped in US1-US3).
   */
  updateStatus(
    ctx: TenantContext,
    memberId: MemberId,
    next: Member,
  ): Promise<Result<Member, RepoError>>;

  /**
   * In-transaction variant for atomic persist+audit on status changes
   * (archive, activate, inactivate). Required by US4 bulk-action and
   * inline-edit use cases to keep the status update + audit row in the
   * same tx as other mutations in the batch (FR-019 all-or-nothing).
   */
  updateStatusInTx(
    tx: TenantTx,
    memberId: MemberId,
    next: Member,
  ): Promise<Result<Member, RepoError>>;

  updateFields(
    ctx: TenantContext,
    memberId: MemberId,
    patch: MemberPatch,
  ): Promise<Result<Member, RepoError>>;

  /** In-transaction variant for atomic persist+audit (COR-8). */
  updateFieldsInTx(
    tx: TenantTx,
    memberId: MemberId,
    patch: MemberPatch,
  ): Promise<Result<Member, RepoError>>;

  /** US2 directory search — substring across company, contact name, email. */
  searchDirectory(
    ctx: TenantContext,
    filter: DirectoryFilter,
  ): Promise<
    Result<
      { readonly items: DirectoryRow[]; readonly nextCursor: string | null },
      RepoError
    >
  >;
}
