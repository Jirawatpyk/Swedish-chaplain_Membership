/**
 * Shared DB-error → `RepoError` mapping for the F3 Drizzle repos
 * (drizzle-member-repo + drizzle-contact-repo). Centralises the
 * unique-violation → `repo.conflict` detection that was duplicated verbatim
 * across every write path, including the Drizzle-0.45 cause-chain fallback.
 */
import { errorChainMessage, isUniqueViolation } from '@/lib/db-errors';
import type {
  RepoConflictReason,
  RepoError,
} from '../../application/ports/member-repo';

/** Wrap an arbitrary caught cause as `repo.unexpected`. */
export function unexpected(cause: unknown): RepoError {
  return { code: 'repo.unexpected', cause };
}

/**
 * Map a caught DB error to `repo.conflict` (with `reason`) when it is a
 * unique-constraint violation, else `repo.unexpected`. Belt-and-braces:
 * checks the structured `isUniqueViolation` AND walks the Drizzle-0.45
 * wrapped-error cause chain for the SQLSTATE message text.
 */
export function mapDbError(
  cause: unknown,
  conflictReason: RepoConflictReason,
): RepoError {
  const msg = errorChainMessage(cause);
  if (isUniqueViolation(cause) || /duplicate key|unique constraint/i.test(msg)) {
    return { code: 'repo.conflict', reason: conflictReason };
  }
  return { code: 'repo.unexpected', cause };
}
