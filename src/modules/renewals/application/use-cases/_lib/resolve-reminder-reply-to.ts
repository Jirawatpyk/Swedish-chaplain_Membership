/**
 * #707 — the tenant's renewal reply-to (`tenant_renewal_settings.reply_to_*`)
 * resolved once per dispatch, then snapshotted on each reminder row so the
 * retry sends what the first attempt sent (see `build-reminder-send-input`).
 *
 * A value Resend would refuse never reaches a send. A malformed address
 * would 422 every reminder of the tenant, so it resolves to "no reply-to";
 * a display name that fails the Domain rule (`domain/reminder-reply-to.ts`)
 * is dropped and the address kept. Either is logged by field, never by
 * value. The admin writer applies the same two checks, so a saved value
 * always passes here.
 *
 * Pure Application — no framework/ORM imports (Constitution Principle III).
 */
import { z } from 'zod';
import { logger } from '@/lib/logger';
import type { TenantRenewalSettings } from '../../../domain/tenant-renewal-settings';
import { REPLY_TO_EMAIL_MAX, checkReplyToDisplayName } from '../../../domain/reminder-reply-to';

export interface ReminderReplyTo {
  readonly email: string;
  readonly displayName: string | null;
}

/**
 * The address check both the dispatcher and the admin writer use (PR B):
 * an address Resend would refuse 422s every reminder of the tenant.
 */
export const reminderReplyToEmailSchema = z.string().email().max(REPLY_TO_EMAIL_MAX);

function warnInvalid(tenantId: string, field: 'email' | 'display_name'): void {
  logger.warn(
    { event: 'renewals.reply_to_invalid', tenantId, field },
    'tenant renewal reply-to is not usable; reminders send without it',
  );
}

export function resolveReminderReplyTo(
  settings: Pick<TenantRenewalSettings, 'replyToEmail' | 'replyToDisplayName'> | null,
  tenantId: string,
): ReminderReplyTo | null {
  const email = settings?.replyToEmail?.trim() ?? '';
  if (email === '') return null;
  if (!reminderReplyToEmailSchema.safeParse(email).success) {
    warnInvalid(tenantId, 'email');
    return null;
  }
  const name = settings?.replyToDisplayName?.trim() ?? '';
  if (name === '') return { email, displayName: null };
  if (checkReplyToDisplayName(name) !== null) {
    warnInvalid(tenantId, 'display_name');
    return { email, displayName: null };
  }
  return { email, displayName: name };
}
