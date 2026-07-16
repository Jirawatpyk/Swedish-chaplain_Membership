/**
 * Email-locale audit 2026-07-16 — resolve a member's preferred email locale
 * for an F4 auto-email enqueue.
 *
 * Returns `undefined` (NOT `'en'`) when there is no member or no stored
 * preference, so the caller can spread it conditionally and let the outbox
 * adapter apply its own `?? 'en'` default — a non-member event buyer
 * (`memberId === null`) has no preference to honour and correctly gets EN.
 */
import type { RecipientLocalePort } from '../ports/recipient-locale-port';
import type { F4OutboxLocale } from '../ports/email-outbox-port';

export async function resolveRecipientLocale(
  port: RecipientLocalePort,
  tx: unknown,
  tenantId: string,
  memberId: string | null,
): Promise<F4OutboxLocale | undefined> {
  if (memberId === null) return undefined;
  return (await port.getMemberEmailLocale(tx, tenantId, memberId)) ?? undefined;
}
