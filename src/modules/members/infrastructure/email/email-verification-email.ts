/**
 * Email-verification email template (F3 US3 / T088 part 1).
 *
 * Delivered after a contact's email is changed (FR-012a) or when an
 * admin resends verification (FR-012c). The recipient clicks the link
 * to confirm the new address is controllable; the token is single-use
 * and expires in 24 hours.
 *
 * Follows the F1 plain-HTML-builder pattern (reset-password-email.ts,
 * invitation-email.ts) — no @react-email render step for MVP. Upgrade
 * to @react-email/components if design parity with marketing emails is
 * ever required.
 *
 * Security notes (mirrors reset-password-email.ts):
 *   - The token is NEVER logged
 *   - The subject line NEVER contains the token
 *   - The body uses the full absolute URL so email clients render it
 *     as a clickable link regardless of inline-HTML sanitisation
 */
import { env } from '@/lib/env';
import { escapeHtml } from '@/lib/html-escape';

export type EmailLocale = 'en' | 'th' | 'sv';

interface VerificationCopy {
  readonly subject: string;
  readonly heading: string;
  readonly intro: string;
  readonly cta: string;
  readonly expiryNotice: string;
  readonly ignoreNotice: string;
  readonly footer: string;
}

const COPY: Record<EmailLocale, VerificationCopy> = {
  en: {
    subject: 'Verify your new SweCham email address',
    heading: 'Verify your email address',
    intro:
      'An administrator updated the contact email on your SweCham account. Click the button below to confirm that this mailbox is yours. Until you confirm, some self-service actions will remain restricted.',
    cta: 'Verify email address',
    expiryNotice: 'This verification link expires in 24 hours.',
    ignoreNotice:
      'If you were not expecting this change, please contact your chamber administrator immediately — there is a revert link in the notification sent to your previous address.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
  th: {
    subject: 'ยืนยันอีเมลใหม่ของ SweCham',
    heading: 'ยืนยันที่อยู่อีเมลของคุณ',
    intro:
      'ผู้ดูแลระบบได้อัปเดตอีเมลติดต่อในบัญชี SweCham ของคุณ คลิกปุ่มด้านล่างเพื่อยืนยันว่ากล่องจดหมายนี้เป็นของคุณ ก่อนการยืนยัน การใช้งาน self-service บางส่วนจะถูกจำกัด',
    cta: 'ยืนยันที่อยู่อีเมล',
    expiryNotice: 'ลิงก์ยืนยันนี้จะหมดอายุภายใน 24 ชั่วโมง',
    ignoreNotice:
      'หากคุณไม่ได้คาดว่าจะมีการเปลี่ยนแปลงนี้ โปรดติดต่อผู้ดูแลหอการค้าของคุณทันที — มีลิงก์ย้อนกลับในอีเมลที่ส่งไปยังที่อยู่เดิมของคุณ',
    footer: 'หอการค้าไทย-สวีเดน (SweCham / TSCC)',
  },
  sv: {
    subject: 'Bekräfta din nya SweCham-e-postadress',
    heading: 'Bekräfta din e-postadress',
    intro:
      'En administratör uppdaterade kontakt-e-posten på ditt SweCham-konto. Klicka på knappen nedan för att bekräfta att den här brevlådan är din. Fram till bekräftelsen förblir vissa självbetjäningsåtgärder begränsade.',
    cta: 'Bekräfta e-postadress',
    expiryNotice: 'Denna bekräftelselänk upphör att gälla om 24 timmar.',
    ignoreNotice:
      'Om du inte förväntade dig denna ändring, kontakta din kammaradministratör omedelbart — det finns en återställningslänk i meddelandet som skickades till din tidigare adress.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
};

export interface VerificationEmailInput {
  readonly toEmail: string;
  readonly token: string;
  readonly locale?: EmailLocale | undefined;
}

export interface BuiltEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function buildEmailVerificationEmail(
  input: VerificationEmailInput,
): BuiltEmail {
  const locale: EmailLocale = input.locale ?? 'en';
  const copy = COPY[locale] ?? COPY.en;
  const url = `${env.app.baseUrl.replace(/\/$/, '')}/email-verification/${encodeURIComponent(input.token)}`;

  const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(copy.subject)}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 40px auto; padding: 24px; color: #111;">
    <h1 style="font-size: 20px; margin-bottom: 16px;">${escapeHtml(copy.heading)}</h1>
    <p style="line-height: 1.6;">${escapeHtml(copy.intro)}</p>
    <p style="margin: 24px 0;">
      <a href="${url}" style="display: inline-block; background: #10487a; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px;">${escapeHtml(copy.cta)}</a>
    </p>
    <p style="color: #555; font-size: 13px;">${escapeHtml(copy.expiryNotice)}</p>
    <p style="color: #555; font-size: 13px;">${escapeHtml(copy.ignoreNotice)}</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
    <p style="color: #777; font-size: 12px;">${escapeHtml(copy.footer)}</p>
  </body>
</html>`;

  const text =
    `${copy.heading}\n\n` +
    `${copy.intro}\n\n` +
    `${url}\n\n` +
    `${copy.expiryNotice}\n\n` +
    `${copy.ignoreNotice}\n\n` +
    `— ${copy.footer}\n`;

  return { subject: copy.subject, html, text };
}
