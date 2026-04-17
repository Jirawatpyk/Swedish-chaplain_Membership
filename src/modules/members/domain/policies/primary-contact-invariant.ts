/**
 * FR-003 — exactly one primary contact per member while status ∈ {active, inactive}.
 *
 * The rule is suspended when the parent member is `archived` — an archived
 * member should still have its final primary contact visible in the directory
 * timeline. The DB partial unique index enforces primary-per-member regardless
 * of parent status (its WHERE clause uses `is_primary = TRUE AND removed_at IS NULL`).
 *
 * Domain asserts this at the Application layer BEFORE persistence — so a
 * Result<Error> is returned to the UI instead of a raw DB constraint exception.
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { Contact } from '../contact';
import type { MemberStatus } from '../member';

export type PrimaryContactViolation =
  | { code: 'primary.zero_primaries' }
  | { code: 'primary.multiple_primaries'; count: number }
  | { code: 'primary.removed_and_primary' };

export function assertPrimaryContactInvariant(
  contacts: readonly Contact[],
  memberStatus: MemberStatus,
): Result<undefined, PrimaryContactViolation> {
  // Archived suspends the exactly-one rule — the final snapshot is kept for audit.
  if (memberStatus === 'archived') return ok(undefined);

  // A removed contact may never be primary (always enforced).
  for (const c of contacts) {
    if (c.isPrimary && c.removedAt !== null)
      return err({ code: 'primary.removed_and_primary' });
  }

  const activePrimaries = contacts.filter(
    (c) => c.isPrimary && c.removedAt === null,
  );
  if (activePrimaries.length === 0)
    return err({ code: 'primary.zero_primaries' });
  if (activePrimaries.length > 1)
    return err({
      code: 'primary.multiple_primaries',
      count: activePrimaries.length,
    });
  return ok(undefined);
}
