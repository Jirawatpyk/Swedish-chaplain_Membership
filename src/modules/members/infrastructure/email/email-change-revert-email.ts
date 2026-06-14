/**
 * Email-change-revert notification template (F3 US3 / T088 part 2).
 *
 * Delivered to the PREVIOUS email address when a contact's email is
 * changed (FR-012b). Gives the user a 48-hour window to revert the
 * change if it was fraudulent — clicking the revert link rolls back
 * the change atomically and flags the linked user for a password
 * reset.
 *
 * Dual-channel pairing: the new address receives an
 * `email-verification-email` at the same time. Together they ensure
 * that neither party (legitimate owner nor attacker) can silently
 * take over the account without the other being notified.
 *
 * Follows the F1 plain-HTML-builder pattern — same discipline as
 * `email-verification-email.ts` and F1 reset-password templates.
 *
 * Security notes:
 *   - The revert token is NEVER logged
 *   - The subject line NEVER contains the token
 *   - Body includes both old and new addresses so the recipient can
 *     verify the change in one glance
 */
import { env } from '@/lib/env';
import { escapeHtml } from '@/lib/html-escape';
import type { EmailLocale, BuiltEmail } from './email-verification-email';

interface RevertCopy {
  readonly subject: string;
  readonly heading: string;
  readonly intro: string;
  readonly changeLine: string;
  readonly cta: string;
  readonly expiryNotice: string;
  readonly legitimateNotice: string;
  readonly footer: string;
}

const COPY: Record<EmailLocale, RevertCopy> = {
  en: {
    subject: 'Your SweCham contact email was changed',
    heading: 'Your contact email was changed',
    intro:
      'The contact email on your SweCham account was just updated. If this change was expected, no action is needed.',
    changeLine: 'Changed from: {old}  →  {new}',
    cta: 'Revert this change and set a new password',
    expiryNotice: 'You have 48 hours to revert this change.',
    legitimateNotice:
      'If you requested this change, you can safely ignore this email. Your existing sessions have been signed out as a security precaution.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
  th: {
    subject: 'อีเมลติดต่อ SweCham ของคุณถูกเปลี่ยนแปลง',
    heading: 'อีเมลติดต่อของคุณถูกเปลี่ยนแปลง',
    intro:
      'อีเมลติดต่อในบัญชี SweCham ของคุณเพิ่งถูกอัปเดต หากการเปลี่ยนแปลงนี้เป็นสิ่งที่คาดไว้ ไม่ต้องดำเนินการใด ๆ',
    changeLine: 'เปลี่ยนจาก: {old}  →  {new}',
    cta: 'ย้อนกลับการเปลี่ยนแปลงนี้และตั้งรหัสผ่านใหม่',
    expiryNotice: 'คุณมีเวลา 48 ชั่วโมงในการย้อนกลับการเปลี่ยนแปลงนี้',
    legitimateNotice:
      'หากคุณเป็นผู้ขอการเปลี่ยนแปลงนี้ สามารถละเว้นอีเมลนี้ได้ เซสชันที่มีอยู่ของคุณถูกออกจากระบบเพื่อความปลอดภัย',
    footer: 'หอการค้าไทย-สวีเดน (SweCham / TSCC)',
  },
  sv: {
    subject: 'Din SweCham-kontakt-e-post har ändrats',
    heading: 'Din kontakt-e-post har ändrats',
    intro:
      'Kontakt-e-posten på ditt SweCham-konto har just uppdaterats. Om ändringen var förväntad behöver du inte göra något.',
    changeLine: 'Ändrat från: {old}  →  {new}',
    cta: 'Återställ denna ändring och välj nytt lösenord',
    expiryNotice: 'Du har 48 timmar på dig att återställa denna ändring.',
    legitimateNotice:
      'Om du begärde ändringen kan du ignorera det här e-postmeddelandet. Dina befintliga sessioner har loggats ut som en säkerhetsåtgärd.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
};

export interface RevertEmailInput {
  readonly toEmail: string;
  /** Previous email address (this recipient). */
  readonly oldEmail: string;
  /** Newly-set email address. */
  readonly newEmail: string;
  readonly token: string;
  readonly locale?: EmailLocale | undefined;
}

export function buildEmailChangeRevertEmail(
  input: RevertEmailInput,
): BuiltEmail {
  const locale: EmailLocale = input.locale ?? 'en';
  const copy = COPY[locale] ?? COPY.en;
  const url = `${env.app.baseUrl.replace(/\/$/, '')}/email-change/revert/${encodeURIComponent(input.token)}`;
  const changeLine = copy.changeLine
    .replace('{old}', input.oldEmail)
    .replace('{new}', input.newEmail);

  const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(copy.subject)}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 40px auto; padding: 24px; color: #111;">
    <h1 style="font-size: 20px; margin-bottom: 16px;">${escapeHtml(copy.heading)}</h1>
    <p style="line-height: 1.6;">${escapeHtml(copy.intro)}</p>
    <p style="background: #f4f6f8; padding: 12px 16px; border-radius: 6px; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6;">${escapeHtml(changeLine)}</p>
    <p style="margin: 24px 0;">
      <a href="${url}" style="display: inline-block; background: #c0392b; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px;">${escapeHtml(copy.cta)}</a>
    </p>
    <p style="color: #555; font-size: 13px;">${escapeHtml(copy.expiryNotice)}</p>
    <p style="color: #555; font-size: 13px;">${escapeHtml(copy.legitimateNotice)}</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
    <p style="color: #777; font-size: 12px;">${escapeHtml(copy.footer)}</p>
  </body>
</html>`;

  const text =
    `${copy.heading}\n\n` +
    `${copy.intro}\n\n` +
    `${changeLine}\n\n` +
    `${url}\n\n` +
    `${copy.expiryNotice}\n\n` +
    `${copy.legitimateNotice}\n\n` +
    `— ${copy.footer}\n`;

  return { subject: copy.subject, html, text };
}
