/**
 * Change-contact-email use case — FR-012a 6-step atomic transaction.
 *
 * Orchestrates six sub-steps inside a single tenant-scoped Postgres
 * transaction. Any failure before commit rolls back the entire set;
 * outbox dispatch failures after commit are handled by the outbox
 * retry loop (FR-012c).
 *
 *   (i)   UPDATE contacts.email              — ContactRepo.updateEmailInTx
 *   (ii)  UPDATE users.email + flag verified — UserEmailPort.updateInTx
 *                                              (sets email_verified=false
 *                                               so F1 sign-in is refused
 *                                               until verification lands
 *                                               — F1 guard ships in US3.b.3)
 *   (iii) DELETE sessions WHERE user_id      — SessionRevocationPort
 *   (iv)  disable OLD-email sign-in          — implicit via step (ii) +
 *                                              email_verified=false;
 *                                              old email no longer exists
 *                                              on the user row so it can
 *                                              never sign in again
 *   (v)   INSERT verification token          — EmailChangeTokenPort
 *         + enqueue verification email       — EmailPort.enqueueInTx
 *   (vi)  INSERT revert token                — EmailChangeTokenPort
 *         + enqueue revert-notification email — EmailPort.enqueueInTx
 *
 * Plus a single `member_contact_email_changed` audit row inserted
 * directly on the tx (mirrors the pattern in drizzle-contact-repo's
 * existing update path).
 *
 * Errors surfaced up:
 *   - `not_found`         — contact missing OR not linked to a user
 *   - `conflict`          — new email already taken on contact OR user
 *                           (unique-index violation)
 *   - `invalid_input`     — new email fails Domain Email validation
 *   - `server_error`      — anything else (rolled back)
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
// The use case writes ONE audit row inside the caller's tx. Going
// through AuditPort would start its own non-tx connection and break
// atomicity. Same pattern as drizzle-contact-repo's existing inserts
// (see its update() method).
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asEmail, type Email } from '../../domain/value-objects/email';
import type { ContactId } from '../../domain/contact';
import type { ContactRepo } from '../ports/contact-repo';
import type { EmailChangeTokenPort } from '../ports/email-change-token-port';
import type { EmailPort } from '../ports/email-port';
import type { SessionRevocationPort } from '../ports/session-revocation-port';
import type { UserEmailPort } from '../ports/user-email-port';
import type { ClockPort } from '../ports/clock-port';
import {
  generateToken,
  hashEmail,
  VERIFICATION_ACTIVATION_DELAY_MS,
  VERIFICATION_TOKEN_TTL_MS,
  REVERT_TOKEN_TTL_MS,
} from '../crypto-helpers';

export type ChangeContactEmailDeps = {
  tenant: TenantContext;
  contactRepo: ContactRepo;
  userEmails: UserEmailPort;
  sessions: SessionRevocationPort;
  tokens: EmailChangeTokenPort;
  emails: EmailPort;
  clock: ClockPort;
};

export type ChangeContactEmailInput = {
  readonly contactId: ContactId;
  readonly newEmailRaw: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly locale: 'en' | 'th' | 'sv';
};

export type ChangeContactEmailError =
  | { code: 'not_found' }
  | { code: 'conflict'; reason: string }
  | { code: 'invalid_input'; field: string }
  | { code: 'server_error'; cause?: unknown };

export type ChangeContactEmailOutput = {
  readonly contactId: ContactId;
  readonly userId: string;
  readonly oldEmail: string;
  readonly newEmail: Email;
  readonly verificationOutboxRowId: string;
  readonly revertOutboxRowId: string;
  readonly sessionsRevoked: number;
};

export async function changeContactEmail(
  deps: ChangeContactEmailDeps,
  input: ChangeContactEmailInput,
): Promise<Result<ChangeContactEmailOutput, ChangeContactEmailError>> {
  // 0. Domain validation on the new email value
  const emailResult = asEmail(input.newEmailRaw);
  if (!emailResult.ok) {
    return err({ code: 'invalid_input', field: 'email' });
  }
  const newEmail = emailResult.value;

  // 1. Load the contact (outside the tx — read-only, keeps the tx short).
  //    Must be linked to a user for FR-012a; otherwise a simpler non-atomic
  //    update-contact flow applies (not this use case).
  const contactResult = await deps.contactRepo.findById(
    deps.tenant,
    input.contactId,
  );
  if (!contactResult.ok) {
    if (contactResult.error.code === 'repo.not_found') {
      return err({ code: 'not_found' });
    }
    return err({ code: 'server_error', cause: contactResult.error });
  }
  const contact = contactResult.value;
  if (!contact.linkedUserId) {
    return err({ code: 'not_found' });
  }
  const userId = contact.linkedUserId;

  // 2. Generate both tokens' plaintext + sha256 hash OUTSIDE the txn — no
  //    value in re-running crypto on rollback. Plaintext flows into the
  //    outbox context_data; the dispatcher renders it into the email body.
  const verificationToken = generateToken();
  const revertToken = generateToken();

  const now = deps.clock.now();

  try {
    const outcome = await runInTenant(deps.tenant, async (tx) => {
      // Step (i) — contact email
      const contactUpdate = await deps.contactRepo.updateEmailInTx(
        tx,
        deps.tenant,
        input.contactId,
        newEmail,
      );
      if (!contactUpdate.ok) throw new PortError(contactUpdate.error);

      // Step (ii) — user email + email_verified = false
      const userUpdate = await deps.userEmails.updateInTx(tx, {
        userId,
        newEmail: newEmail as string,
        setEmailVerified: false,
      });
      if (!userUpdate.ok) throw new PortError(userUpdate.error);

      // Step (iii) — revoke every active session for the affected user.
      // This also logically covers step (iv): the old email is gone
      // from the user row after step (ii), and any client still holding
      // a session cookie is now signed out.
      const sessionResult = await deps.sessions.revokeAllForInTx(
        tx,
        userId,
        'email_change',
      );
      if (!sessionResult.ok) throw new PortError(sessionResult.error);

      // Step (v) — verification token + outbox enqueue
      const verificationActivated = new Date(
        now.getTime() + VERIFICATION_ACTIVATION_DELAY_MS,
      );
      const verificationExpires = new Date(
        now.getTime() + VERIFICATION_TOKEN_TTL_MS,
      );
      const verificationInsert = await deps.tokens.insertInTx(
        tx,
        deps.tenant,
        {
          tokenId: verificationToken.hash,
          contactId: input.contactId,
          userId,
          type: 'verification',
          oldEmail: userUpdate.value.oldEmail,
          newEmail: newEmail as string,
          activatedAt: verificationActivated,
          expiresAt: verificationExpires,
        },
      );
      if (!verificationInsert.ok) throw new PortError(verificationInsert.error);

      const verificationEnqueue = await deps.emails.enqueueInTx(
        tx,
        deps.tenant,
        {
          type: 'email_verification',
          toEmail: newEmail as string,
          locale: input.locale,
          contextData: {
            token: verificationToken.plaintext,
            activatedAt: verificationActivated.toISOString(),
            expiresAt: verificationExpires.toISOString(),
            userId,
            contactId: input.contactId,
          },
        },
      );
      if (!verificationEnqueue.ok) throw new PortError(verificationEnqueue.error);

      // Step (vi) — revert token + outbox enqueue
      const revertExpires = new Date(now.getTime() + REVERT_TOKEN_TTL_MS);
      const revertInsert = await deps.tokens.insertInTx(tx, deps.tenant, {
        tokenId: revertToken.hash,
        contactId: input.contactId,
        userId,
        type: 'revert',
        oldEmail: userUpdate.value.oldEmail,
        newEmail: newEmail as string,
        activatedAt: now,
        expiresAt: revertExpires,
      });
      if (!revertInsert.ok) throw new PortError(revertInsert.error);

      const revertEnqueue = await deps.emails.enqueueInTx(tx, deps.tenant, {
        type: 'email_change_revert',
        toEmail: userUpdate.value.oldEmail,
        locale: input.locale,
        contextData: {
          token: revertToken.plaintext,
          oldEmail: userUpdate.value.oldEmail,
          newEmail: newEmail as string,
          expiresAt: revertExpires.toISOString(),
          userId,
          contactId: input.contactId,
        },
      });
      if (!revertEnqueue.ok) throw new PortError(revertEnqueue.error);

      // Audit — single event row carrying the full context. Inserted
      // inside the tx for atomicity + to trigger the F3 `members.
      // last_activity_at` bump (migration 0009 trigger).
      await tx.insert(auditLog).values({
        eventType: 'member_contact_email_changed',
        actorUserId: input.actorUserId,
        targetUserId: userId,
        summary: `contact email changed for contact ${input.contactId}`,
        requestId: input.requestId,
        tenantId: deps.tenant.slug,
        payload: {
          member_id: contact.memberId,
          contact_id: input.contactId,
          user_id: userId,
          // Emails hashed per data-model.md § 4 — audit_log is
          // append-only with ≥5-year retention; plaintext PII violates
          // PDPA § 37 + GDPR Art 5(1)(c) data minimisation.
          old_email_hash: hashEmail(userUpdate.value.oldEmail),
          new_email_hash: hashEmail(newEmail as string),
          sessions_revoked: sessionResult.value.revokedCount,
          verification_enqueued: true,
          revert_enqueued: true,
        },
      });

      return {
        oldEmail: userUpdate.value.oldEmail,
        sessionsRevoked: sessionResult.value.revokedCount,
        verificationOutboxRowId: verificationEnqueue.value.outboxRowId,
        revertOutboxRowId: revertEnqueue.value.outboxRowId,
      };
    });

    return ok({
      contactId: input.contactId,
      userId,
      oldEmail: outcome.oldEmail,
      newEmail,
      verificationOutboxRowId: outcome.verificationOutboxRowId,
      revertOutboxRowId: outcome.revertOutboxRowId,
      sessionsRevoked: outcome.sessionsRevoked,
    });
  } catch (e) {
    if (e instanceof PortError) {
      const re = e.repoError;
      if (re.code === 'repo.not_found') return err({ code: 'not_found' });
      if (re.code === 'repo.conflict') {
        return err({ code: 'conflict', reason: re.reason });
      }
      return err({ code: 'server_error', cause: re });
    }
    return err({ code: 'server_error', cause: e });
  }
}

/**
 * Internal error wrapper so port-layer failures (which are Result-typed)
 * can abort the runInTenant transaction via throw → rollback, and be
 * mapped back to a typed use-case error at the outer catch.
 */
class PortError extends Error {
  constructor(
    public readonly repoError:
      | { code: 'repo.not_found' }
      | { code: 'repo.conflict'; reason: string }
      | { code: 'repo.unexpected'; cause?: unknown },
  ) {
    super(`port error: ${repoError.code}`);
  }
}
