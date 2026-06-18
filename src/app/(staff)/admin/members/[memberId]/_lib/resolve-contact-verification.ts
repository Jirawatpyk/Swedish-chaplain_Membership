// src/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification.ts
/**
 * DV-11 — per-contact email-verification resolver (visible-gate for the
 * "Re-send verification email" button). Mirrors resolve-contact-subscriptions:
 * the page injects the F1 `isEmailVerified` callable so this stays unit-testable
 * without a live read, and the page (presentation) never calls the port shape
 * directly. Best-effort: a read error for a contact omits it (button hidden on
 * unknown state — safer than offering a possibly no-op resend).
 */
import type { Result } from '@/lib/result';

export interface VerificationResolverLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface VerifiableContact {
  readonly contactId: string;
  readonly linkedUserId: string | null;
  readonly removedAt: Date | null;
}

export type IsVerified = (userId: string) => Promise<Result<boolean, unknown>>;

export interface ResolveContactVerificationArgs {
  readonly contacts: ReadonlyArray<VerifiableContact>;
  readonly memberId: string;
  readonly isVerified: IsVerified;
  readonly logger: VerificationResolverLogger;
  readonly errKind: (e: unknown) => string;
}

export async function resolveContactVerification({
  contacts,
  memberId,
  isVerified,
  logger,
  errKind,
}: ResolveContactVerificationArgs): Promise<{ pending: ReadonlySet<string> }> {
  const pending = new Set<string>();
  const live = contacts.filter((c) => c.removedAt === null && c.linkedUserId);
  await Promise.all(
    live.map(async (c) => {
      try {
        const res = await isVerified(c.linkedUserId as string);
        if (res.ok) {
          if (res.value === false) pending.add(c.contactId);
        } else {
          logger.warn(
            { event: 'contact_verification_read_err', contactId: c.contactId, memberId },
            '[DV-11] isEmailVerified returned err — contact treated as not-pending',
          );
        }
      } catch (e) {
        logger.warn(
          { event: 'contact_verification_threw', errKind: errKind(e), contactId: c.contactId, memberId },
          '[DV-11] isEmailVerified threw — contact treated as not-pending',
        );
      }
    }),
  );
  return { pending };
}
