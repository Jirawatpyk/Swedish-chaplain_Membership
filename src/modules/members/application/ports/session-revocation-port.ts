/**
 * Application port — revoke all sessions for a user.
 *
 * Used by `change-contact-email.ts` (FR-012a) to terminate every
 * active session for a contact's linked user in the same transaction
 * as the email change. Implemented by an adapter that calls into the
 * F1 auth module via its public barrel.
 *
 * Two surfaces:
 *   - `revokeAllFor`        — stand-alone call (opens its own txn).
 *   - `revokeAllForInTx`    — caller-provided tx for the FR-012a
 *                             6-step atomic orchestration.
 *
 * `TenantTx` is a documented port-level leak of an infrastructure
 * type, same as `EmailPort.enqueueInTx` (see resend-email-port.ts).
 * It is unavoidable because cross-module atomicity requires a shared
 * transaction handle.
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { RepoError } from './member-repo';

export type RevocationReason = 'email_change' | 'admin_force';

export interface SessionRevocationPort {
  revokeAllFor(
    userId: string,
    reason: RevocationReason,
  ): Promise<Result<{ revokedCount: number }, RepoError>>;

  revokeAllForInTx(
    tx: TenantTx,
    userId: string,
    reason: RevocationReason,
  ): Promise<Result<{ revokedCount: number }, RepoError>>;
}
