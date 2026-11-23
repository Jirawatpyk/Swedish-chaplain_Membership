/**
 * PR B (#707 follow-up) — staff set or clear the renewal reminder Reply-To
 * (`tenant_renewal_settings.reply_to_email` / `reply_to_display_name`).
 *
 * - Validation is the dispatcher's own (`reminderReplyToEmailSchema` and the
 *   Domain `checkReplyToDisplayName`), so a saved value always reaches the
 *   reminders; an empty address clears both fields; a name needs an address.
 * - Nothing is written, and nothing audited, when the values don't change.
 * - The upsert and the `renewal_reply_to_updated` audit row commit together
 *   (Constitution Principle VIII). The audit keeps the address's domain only,
 *   never the address: an F8 row lives 5 years, and a personal staff address
 *   there would outlive a staff erasure request (PDPA; the user's choice).
 * - Reminder rows already created keep the reply-to they were snapshotted
 *   with (#707), so a change here never alters a retry's request body.
 *
 * The prior row is read outside the transaction (the schedule-policy pattern):
 * two staff saving at once can both audit against the same prior value, which
 * only blurs `change`; the final row is the later save either way.
 *
 * Pure Application — no framework/ORM imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errClassWithCode, errKind } from '@/lib/log-id';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { checkReplyToDisplayName } from '../../domain/reminder-reply-to';
import { reminderReplyToEmailSchema } from './_lib/resolve-reminder-reply-to';

export interface UpdateRenewalReplyToInput {
  readonly tenantId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly actorUserId: string;
  /** The literal role the `settings.renewal_schedules` gate admits. */
  readonly actorRole: 'admin' | 'super_admin';
  readonly correlationId: string;
  readonly requestId?: string | null;
}

export interface UpdateRenewalReplyToOutput {
  readonly email: string | null;
  readonly displayName: string | null;
  /** False when the saved values matched the stored ones (no write, no audit). */
  readonly changed: boolean;
}

export type UpdateRenewalReplyToError =
  | { readonly kind: 'invalid_email' }
  | { readonly kind: 'invalid_display_name'; readonly reason: 'unsafe_character' | 'too_long' }
  | { readonly kind: 'display_name_without_email' }
  | { readonly kind: 'server_error'; readonly message: string };

const actorRoleSchema = z.enum(['admin', 'super_admin']);

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

export async function updateRenewalReplyTo(
  deps: Pick<RenewalsDeps, 'tenant' | 'tenantRenewalSettingsRepo' | 'auditEmitter'>,
  input: UpdateRenewalReplyToInput,
): Promise<Result<UpdateRenewalReplyToOutput, UpdateRenewalReplyToError>> {
  return withActiveSpan(
    renewalsTracer(),
    'admin_renewal_reply_to_update',
    { 'tenant.id': input.tenantId, 'actor.role': input.actorRole },
    async () => updateInner(),
  );

  async function updateInner(): Promise<Result<UpdateRenewalReplyToOutput, UpdateRenewalReplyToError>> {
    const actorRole = actorRoleSchema.parse(input.actorRole);
    const email = input.email?.trim() || null;
    const displayName = input.displayName?.trim() || null;
    if (email === null && displayName !== null) return err({ kind: 'display_name_without_email' });
    if (email !== null && !reminderReplyToEmailSchema.safeParse(email).success) {
      return err({ kind: 'invalid_email' });
    }
    if (displayName !== null) {
      const problem = checkReplyToDisplayName(displayName);
      if (problem !== null) return err({ kind: 'invalid_display_name', reason: problem });
    }

    try {
      const prior = await deps.tenantRenewalSettingsRepo.findByTenant(input.tenantId);
      const priorEmail = prior?.replyToEmail ?? null;
      const priorName = prior?.replyToDisplayName ?? null;
      if (priorEmail === email && priorName === displayName) {
        return ok({ email, displayName, changed: false });
      }
      const change: 'set' | 'changed' | 'cleared' =
        email === null ? 'cleared' : priorEmail === null ? 'set' : 'changed';

      await runInTenant(deps.tenant, async (tx) => {
        await deps.tenantRenewalSettingsRepo.upsert(tx, input.tenantId, {
          replyToEmail: email,
          replyToDisplayName: displayName,
        });
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'renewal_reply_to_updated',
            payload: {
              change,
              email_set: email !== null,
              email_domain: email === null ? null : emailDomain(email),
              display_name_set: displayName !== null,
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorRole,
            correlationId: input.correlationId,
            requestId: input.requestId ?? null,
            summary: `Renewal reminder reply-to ${change}`,
          },
        );
      });
      return ok({ email, displayName, changed: true });
    } catch (e) {
      logger.error(
        { err: errKind(e), tenantId: input.tenantId, correlationId: input.correlationId },
        'updateRenewalReplyTo: unexpected error',
      );
      return err({ kind: 'server_error', message: errClassWithCode(e) });
    }
  }
}
