// src/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification.ts
/**
 * DV-11 — per-contact email-verification resolver (visible-gate for the
 * "Re-send verification email" button). Mirrors resolve-contact-subscriptions:
 * the page injects the `isVerifiedBatch` callable so this stays unit-testable
 * without a live read, and the page (presentation) never calls the port shape
 * directly.
 *
 * Replaces the previous per-user fan-out with a single batched read (code-review
 * finding #7). Collects all live-contact userIds, calls isVerifiedBatch ONCE,
 * then projects: contactId is pending ⟺ its linkedUserId is NOT in the
 * returned verifiedSet.
 *
 * Best-effort: on err or throw → empty pending set (button hidden on unknown —
 * safer than offering a possibly no-op resend) + one logger.warn.
 */
import type { Result } from '@/lib/result';

export interface VerificationResolverLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface VerifiableContact {
  readonly contactId: string;
  readonly linkedUserId: string | null;
  readonly removedAt: Date | null;
}

export type IsVerifiedBatch = (
  userIds: readonly string[],
) => Promise<Result<ReadonlySet<string>, unknown>>;

export interface ResolveContactVerificationArgs {
  readonly contacts: ReadonlyArray<VerifiableContact>;
  readonly memberId: string;
  readonly isVerifiedBatch: IsVerifiedBatch;
  readonly logger: VerificationResolverLogger;
  readonly errKind: (e: unknown) => string;
}

export async function resolveContactVerification({
  contacts,
  memberId,
  isVerifiedBatch,
  logger,
  errKind,
}: ResolveContactVerificationArgs): Promise<{ pending: ReadonlySet<string> }> {
  // Collect live contacts that have a linked user (the only ones we can query).
  const live = contacts.filter((c) => c.removedAt === null && c.linkedUserId !== null);
  if (live.length === 0) return { pending: new Set<string>() };

  const userIds = live.map((c) => c.linkedUserId as string);

  try {
    const res = await isVerifiedBatch(userIds);
    if (!res.ok) {
      logger.warn(
        { event: 'contact_verification_batch_read_err', memberId },
        '[DV-11] isEmailVerifiedBatch returned err — all contacts treated as not-pending',
      );
      return { pending: new Set<string>() };
    }
    const verifiedSet = res.value;
    // pending = contacts whose linkedUserId is NOT in verifiedSet
    const pending = new Set<string>();
    for (const c of live) {
      if (!verifiedSet.has(c.linkedUserId as string)) {
        pending.add(c.contactId);
      }
    }
    return { pending };
  } catch (e) {
    logger.warn(
      { event: 'contact_verification_batch_read_threw', errKind: errKind(e), memberId },
      '[DV-11] isEmailVerifiedBatch threw — all contacts treated as not-pending',
    );
    return { pending: new Set<string>() };
  }
}
