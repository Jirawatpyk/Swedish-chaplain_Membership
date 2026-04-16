/**
 * Resend-verification-email use case — FR-012c admin action.
 *
 * When the outbox dispatcher flips a row to `permanently_failed` after
 * 5 attempts, the admin UI exposes a "Re-send verification email"
 * button on the member detail page (T097). This use case backs that
 * button: it invalidates any outstanding verification tokens for the
 * user, issues a fresh 24h token + 5-minute activation delay, and
 * enqueues a new outbox row.
 *
 * Emits `email_verification_resent` audit event (data-model.md § 4).
 *
 * Authorisation: admin-only. Enforced at the API layer; the use case
 * takes the actorUserId verbatim for the audit payload.
 *
 * Scope: only the NEW-address verification email is re-sent. The OLD
 * address's revert notification is NOT re-issued — the admin would
 * only hit this button when the contact-email change already
 * committed, and re-sending the revert window would extend the
 * takeover opportunity beyond the spec's 48h ceiling.
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { ContactId } from '../../domain/contact';
import type { ContactRepo } from '../ports/contact-repo';
import type { EmailChangeTokenPort } from '../ports/email-change-token-port';
import type { EmailPort } from '../ports/email-port';
import type { ClockPort } from '../ports/clock-port';
import {
  generateToken,
  VERIFICATION_ACTIVATION_DELAY_MS,
  VERIFICATION_TOKEN_TTL_MS,
} from '../crypto-helpers';

export type ResendVerificationDeps = {
  tenant: TenantContext;
  contactRepo: ContactRepo;
  tokens: EmailChangeTokenPort;
  emails: EmailPort;
  clock: ClockPort;
};

export type ResendVerificationInput = {
  readonly contactId: ContactId;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly locale: 'en' | 'th' | 'sv';
};

export type ResendVerificationError =
  | { code: 'not_found' }
  | { code: 'not_eligible'; reason: 'no_linked_user' | 'email_verified' }
  | { code: 'server_error'; cause?: unknown };

export type ResendVerificationOutput = {
  readonly userId: string;
  readonly contactId: ContactId;
  readonly newEmail: string;
  readonly outboxRowId: string;
  readonly invalidatedPrior: number;
};

export async function resendVerificationEmail(
  deps: ResendVerificationDeps,
  input: ResendVerificationInput,
): Promise<Result<ResendVerificationOutput, ResendVerificationError>> {
  // Load contact outside the tx
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
    return err({ code: 'not_eligible', reason: 'no_linked_user' });
  }
  const userId = contact.linkedUserId;

  const now = deps.clock.now();
  const token = generateToken();
  const activatedAt = new Date(now.getTime() + VERIFICATION_ACTIVATION_DELAY_MS);
  const expiresAt = new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS);

  try {
    const outcome = await runInTenant(deps.tenant, async (tx) => {
      // Invalidate prior outstanding verification tokens — only one
      // verification should be redeemable at a time.
      const prior = await deps.tokens.invalidateActiveForUserInTx(
        tx,
        userId,
        'verification',
        now,
      );
      if (!prior.ok) {
        throw new UseCaseAbort({ code: 'server_error', cause: prior.error });
      }

      // Issue fresh token.
      // Note: oldEmail here is contact.email — for resend we do NOT know
      // the "pre-change" email anymore because the change already
      // committed. We populate oldEmail = newEmail so downstream audit
      // columns stay consistent; the revert-flow path isn't reachable
      // from this use case.
      const inserted = await deps.tokens.insertInTx(tx, deps.tenant, {
        tokenId: token.hash,
        contactId: input.contactId,
        userId,
        type: 'verification',
        oldEmail: contact.email,
        newEmail: contact.email,
        activatedAt,
        expiresAt,
      });
      if (!inserted.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: inserted.error,
        });
      }

      const enqueued = await deps.emails.enqueueInTx(tx, deps.tenant, {
        type: 'email_verification_resent',
        toEmail: contact.email,
        locale: input.locale,
        contextData: {
          token: token.plaintext,
          activatedAt: activatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          userId,
          contactId: input.contactId,
        },
      });
      if (!enqueued.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: enqueued.error,
        });
      }

      await tx.insert(auditLog).values({
        eventType: 'email_verification_resent',
        actorUserId: input.actorUserId,
        targetUserId: userId,
        summary: `verification email re-sent for user ${userId}`,
        requestId: input.requestId,
        tenantId: deps.tenant.slug,
        payload: {
          member_id: contact.memberId,
          contact_id: input.contactId,
          user_id: userId,
          new_token_id: token.hash,
          invalidated_prior: prior.value.invalidatedCount,
          outbox_row_id: enqueued.value.outboxRowId,
        },
      });

      return {
        userId,
        outboxRowId: enqueued.value.outboxRowId,
        invalidatedPrior: prior.value.invalidatedCount,
      };
    });

    return ok({
      userId: outcome.userId,
      contactId: input.contactId,
      newEmail: contact.email,
      outboxRowId: outcome.outboxRowId,
      invalidatedPrior: outcome.invalidatedPrior,
    });
  } catch (e) {
    if (e instanceof UseCaseAbort) return err(e.error);
    return err({ code: 'server_error', cause: e });
  }
}

class UseCaseAbort extends Error {
  constructor(public readonly error: ResendVerificationError) {
    super(error.code);
  }
}
