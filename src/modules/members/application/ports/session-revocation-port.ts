/**
 * Application port — revoke all sessions for a user.
 *
 * Used by `change-contact-email.ts` (FR-012a) to terminate every
 * active session for a contact's linked user in the same transaction
 * as the email change. Implemented by an adapter that calls into the
 * F1 auth module via its public barrel.
 */
import type { Result } from '@/lib/result';
import type { RepoError } from './member-repo';

export interface SessionRevocationPort {
  revokeAllFor(
    userId: string,
    reason: 'email_change' | 'admin_force',
  ): Promise<Result<{ revokedCount: number }, RepoError>>;
}
