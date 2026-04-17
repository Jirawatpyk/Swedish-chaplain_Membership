/**
 * Application port — `email_change_tokens` writer.
 *
 * Used by the FR-012a 6-step atomic txn to persist the verification
 * (to NEW address) + revert (to OLD address) tokens. Also used by the
 * US3.b.3 "re-send verification" admin action + revert / verify
 * consumption use cases (follow-up session).
 *
 * Tokens are stored as sha256 hex digests; plaintext exists only in
 * the outbox row's `context_data` and the outbound email body.
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { RepoError } from './member-repo';

export type TokenType = 'verification' | 'revert';

export type TokenDraft = {
  /** sha256 hex digest of the plaintext token. */
  readonly tokenId: string;
  readonly contactId: string;
  readonly userId: string;
  readonly type: TokenType;
  readonly oldEmail: string;
  readonly newEmail: string;
  readonly activatedAt: Date;
  readonly expiresAt: Date;
};

/**
 * Row returned by `findActiveByIdInTx` — the full set of fields the
 * consumption / revert use cases need to decide whether the token is
 * consumable and what to do with it.
 */
export type ActiveToken = {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly contactId: string;
  readonly userId: string;
  readonly type: TokenType;
  readonly oldEmail: string;
  readonly newEmail: string;
  readonly activatedAt: Date;
  readonly expiresAt: Date;
};

export interface EmailChangeTokenPort {
  /**
   * Stand-alone token lookup — used by the public consumption endpoints
   * (no TenantContext available at the HTTP boundary — the tenant is
   * derived FROM the token row). Returns the same fields as the
   * in-tx variant; caller then opens a runInTenant transaction with
   * `tenantId` and proceeds with consumption.
   *
   * `email_change_tokens` carries no RLS policy so the default DB
   * owner can read it — migration 0012 intentionally scoped the
   * table outside the per-tenant isolation wall for this reason.
   */
  findActiveById(tokenId: string): Promise<Result<ActiveToken, RepoError>>;

  insertInTx(
    tx: TenantTx,
    ctx: TenantContext,
    draft: TokenDraft,
  ): Promise<Result<{ tokenId: string }, RepoError>>;

  /**
   * Look up an unconsumed, unexpired token by its sha256-hashed id
   * inside the caller's transaction. Returns `repo.not_found` when the
   * token does not exist, is already consumed, or is past its expiry.
   * Does NOT check `activatedAt` — callers enforce the 5-minute
   * activation window themselves (so the domain-level error is
   * attributable).
   */
  findActiveByIdInTx(
    tx: TenantTx,
    tokenId: string,
  ): Promise<Result<ActiveToken, RepoError>>;

  /** Mark a token consumed (idempotent on already-consumed rows). */
  markConsumedInTx(
    tx: TenantTx,
    tokenId: string,
    consumedAt: Date,
  ): Promise<Result<undefined, RepoError>>;

  /**
   * Invalidate every still-active (unconsumed + unexpired) revert
   * token for a user — used when the matching verification consumes
   * successfully so the no-longer-relevant revert window closes
   * cleanly. Returns the number of rows affected.
   */
  invalidateActiveForUserInTx(
    tx: TenantTx,
    userId: string,
    type: TokenType,
    consumedAt: Date,
  ): Promise<Result<{ invalidatedCount: number }, RepoError>>;
}
