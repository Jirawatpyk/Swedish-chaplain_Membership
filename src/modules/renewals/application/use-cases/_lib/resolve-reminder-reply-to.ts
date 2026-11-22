/**
 * #707 — the tenant's renewal reply-to (`tenant_renewal_settings.reply_to_*`)
 * resolved once per dispatch, then snapshotted on each reminder row so the
 * retry sends what the first attempt sent (see `build-reminder-send-input`).
 *
 * A value Resend would refuse never reaches a send. A malformed address
 * would 422 every reminder of the tenant, so it resolves to "no reply-to";
 * a display name with a control character (a header injection), an RFC 5322
 * special (`( ) < > [ ] : ; @ \ , "`, which could make the unquoted header
 * name another address), or over 100 characters is dropped and the address
 * kept. Either is logged by field,
 * never by value.
 *
 * Pure Application — no framework/ORM imports (Constitution Principle III).
 */
import { z } from 'zod';
import { logger } from '@/lib/logger';
import type { TenantRenewalSettings } from '../../../domain/tenant-renewal-settings';

export interface ReminderReplyTo {
  readonly email: string;
  readonly displayName: string | null;
}

const EMAIL = z.string().email().max(254);
const MAX_DISPLAY_NAME = 100;
// Control characters (line breaks included, and U+2028/2029), and every
// RFC 5322 special — the gateway writes the name UNQUOTED as `Name <email>`,
// so a special could make it a second address, a group (`:`) or a comment
// (review round 1: PDPA L-1, code-review, reliability M-1). Rejected here,
// before the snapshot, so the header format itself never has to change: a
// changed format would change the payload of rows already mid-retry.
const UNSAFE_DISPLAY_NAME = /[\u0000-\u001f\u007f\u2028\u2029<>()[\]:;@\\,"]/;

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
  if (!EMAIL.safeParse(email).success) {
    warnInvalid(tenantId, 'email');
    return null;
  }
  const name = settings?.replyToDisplayName?.trim() ?? '';
  if (name === '') return { email, displayName: null };
  if (UNSAFE_DISPLAY_NAME.test(name) || name.length > MAX_DISPLAY_NAME) {
    warnInvalid(tenantId, 'display_name');
    return { email, displayName: null };
  }
  return { email, displayName: name };
}
