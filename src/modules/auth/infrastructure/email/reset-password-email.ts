/**
 * Reset-password email template (T098).
 *
 * Simple HTML + plain-text builder — no @react-email render step for
 * MVP so the template is pure data that is easy to unit-test. Upgrade
 * to @react-email/components if we ever need design parity with
 * marketing emails.
 *
 * Localisation: the caller passes a locale; the template picks the
 * right message set. Missing locales fall back to `en`. The reset URL
 * is built from `env.app.baseUrl` + `/reset-password/<token>` so there
 * is ONE source of truth for the link shape.
 *
 * Security notes:
 *   - The token is NEVER logged
 *   - The subject line NEVER contains the token
 *   - The body uses the full absolute URL so email clients render it
 *     as a clickable link regardless of inline-HTML sanitisation
 */
import { env } from '@/lib/env';
import { escapeHtml } from '@/lib/html-escape';
import { EMAIL_BRAND_PRIMARY } from '@/lib/email-brand';

export type EmailLocale = 'en' | 'th' | 'sv';

interface EmailCopy {
  readonly subject: string;
  readonly heading: string;
  readonly intro: string;
  readonly cta: string;
  readonly expiryNotice: string;
  readonly ignoreNotice: string;
  readonly footer: string;
}

const COPY: Record<EmailLocale, EmailCopy> = {
  en: {
    subject: 'Reset your SweCham password',
    heading: 'Reset your password',
    intro:
      'We received a request to reset the password for your SweCham account. Click the link below to choose a new password.',
    cta: 'Reset password',
    expiryNotice: 'This link expires in 1 hour.',
    ignoreNotice:
      'If you did not request a password reset, you can safely ignore this email — your password will not be changed.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
  th: {
    subject: 'รีเซ็ตรหัสผ่าน SweCham',
    heading: 'รีเซ็ตรหัสผ่านของคุณ',
    intro:
      'เราได้รับคำขอรีเซ็ตรหัสผ่านสำหรับบัญชี SweCham ของคุณ คลิกลิงก์ด้านล่างเพื่อเลือกรหัสผ่านใหม่',
    cta: 'รีเซ็ตรหัสผ่าน',
    expiryNotice: 'ลิงก์นี้จะหมดอายุภายใน 1 ชั่วโมง',
    ignoreNotice:
      'หากคุณไม่ได้ร้องขอการรีเซ็ตรหัสผ่าน คุณสามารถเพิกเฉยต่ออีเมลนี้ได้ — รหัสผ่านของคุณจะไม่ถูกเปลี่ยน',
    footer: 'หอการค้าไทย-สวีเดน (SweCham / TSCC)',
  },
  sv: {
    subject: 'Återställ ditt SweCham-lösenord',
    heading: 'Återställ ditt lösenord',
    intro:
      'Vi har fått en begäran om att återställa lösenordet för ditt SweCham-konto. Klicka på länken nedan för att välja ett nytt lösenord.',
    cta: 'Återställ lösenord',
    expiryNotice: 'Den här länken upphör att gälla om 1 timme.',
    ignoreNotice:
      'Om du inte begärt en lösenordsåterställning kan du ignorera det här mejlet — ditt lösenord kommer inte att ändras.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
};

export interface ResetPasswordEmailInput {
  readonly toEmail: string;
  readonly token: string;
  readonly locale?: EmailLocale | undefined;
}

export interface BuiltEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function buildResetPasswordEmail(input: ResetPasswordEmailInput): BuiltEmail {
  const locale: EmailLocale = input.locale ?? 'en';
  const copy = COPY[locale] ?? COPY.en;
  const url = `${env.app.baseUrl.replace(/\/$/, '')}/reset-password/${encodeURIComponent(input.token)}`;

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
      <a href="${url}" style="display: inline-block; background: ${EMAIL_BRAND_PRIMARY}; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px;">${escapeHtml(copy.cta)}</a>
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
