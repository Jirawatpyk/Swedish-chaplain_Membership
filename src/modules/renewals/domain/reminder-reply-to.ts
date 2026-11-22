/**
 * The renewal reminder Reply-To's limits and display-name rule (#707, PR B).
 *
 * One home for the rule the dispatcher (`resolve-reminder-reply-to`) and the
 * admin writer (`update-renewal-reply-to`) both apply, so the settings page
 * can never save a name the dispatcher would silently drop.
 *
 * The gateway writes the header unquoted as `Name <email>`, so a name that
 * held a control character (a header injection), a line separator, or an
 * RFC 5322 special (`( ) < > [ ] : ; @ \ , "`) could become a second
 * address, a group or a comment. Such a name is refused here, and the header
 * format itself never changes: a changed format would change the request
 * body of reminder rows already mid-retry.
 *
 * Pure Domain — no framework imports (Constitution Principle III).
 */

/** The longest address Resend and RFC 5321 accept. */
export const REPLY_TO_EMAIL_MAX = 254;
export const REPLY_TO_DISPLAY_NAME_MAX = 100;

const UNSAFE_DISPLAY_NAME = /[\u0000-\u001f\u007f\u2028\u2029<>()[\]:;@\\,"]/;

export type ReplyToDisplayNameProblem = 'unsafe_character' | 'too_long';

/** `null` when the (already trimmed) name is safe to send. */
export function checkReplyToDisplayName(name: string): ReplyToDisplayNameProblem | null {
  if (UNSAFE_DISPLAY_NAME.test(name)) return 'unsafe_character';
  if (name.length > REPLY_TO_DISPLAY_NAME_MAX) return 'too_long';
  return null;
}
