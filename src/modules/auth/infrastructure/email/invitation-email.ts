/**
 * Invitation email template (T122).
 *
 * Same HTML-builder shape as `reset-password-email.ts` — plain data in,
 * built HTML + plain-text out. No @react-email dependency. Localised
 * en/th/sv; the invitee's locale is not yet known at invitation time
 * (their account is pending), so the invitee receives whatever locale
 * the admin was using when they submitted the form.
 */
import { env } from '@/lib/env';
import type { Role } from '@/modules/auth/domain/role';
import type { EmailLocale } from './reset-password-email';

interface InvitationEmailCopy {
  readonly subject: string;
  readonly heading: string;
  readonly intro: string;
  readonly roleLine: string;
  readonly cta: string;
  readonly expiryNotice: string;
  readonly footer: string;
}

const COPY: Record<EmailLocale, InvitationEmailCopy> = {
  en: {
    subject: "You're invited to SweCham / TSCC",
    heading: "You're invited",
    intro:
      'An administrator has invited you to join the Thailand-Swedish Chamber of Commerce membership platform. Click the button below to set your password and activate your account.',
    roleLine: 'You are being added as: {role}',
    cta: 'Set password and sign in',
    expiryNotice: 'This invitation expires in 7 days.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
  th: {
    subject: 'คุณได้รับคำเชิญเข้าร่วม SweCham / TSCC',
    heading: 'คุณได้รับคำเชิญ',
    intro:
      'ผู้ดูแลระบบได้เชิญคุณเข้าร่วมระบบสมาชิก หอการค้าไทย-สวีเดน (TSCC) คลิกปุ่มด้านล่างเพื่อตั้งรหัสผ่านและเปิดใช้งานบัญชีของคุณ',
    roleLine: 'คุณจะถูกเพิ่มในฐานะ: {role}',
    cta: 'ตั้งรหัสผ่านและเข้าสู่ระบบ',
    expiryNotice: 'คำเชิญนี้จะหมดอายุภายใน 7 วัน',
    footer: 'หอการค้าไทย-สวีเดน (SweCham / TSCC)',
  },
  sv: {
    subject: 'Du är inbjuden till SweCham / TSCC',
    heading: 'Du är inbjuden',
    intro:
      'En administratör har bjudit in dig till Thailand-Swedish Chamber of Commerce medlemsplattform. Klicka på knappen nedan för att välja ett lösenord och aktivera ditt konto.',
    roleLine: 'Du läggs till som: {role}',
    cta: 'Välj lösenord och logga in',
    expiryNotice: 'Den här inbjudan upphör att gälla om 7 dagar.',
    footer: 'Thailand-Swedish Chamber of Commerce (SweCham / TSCC)',
  },
};

const ROLE_LABELS: Record<EmailLocale, Record<Role, string>> = {
  en: { admin: 'Administrator', manager: 'Manager', member: 'Member' },
  th: { admin: 'ผู้ดูแลระบบ', manager: 'ผู้จัดการ', member: 'สมาชิก' },
  sv: { admin: 'Administratör', manager: 'Chef', member: 'Medlem' },
};

export interface InvitationEmailInput {
  readonly toEmail: string;
  readonly token: string;
  readonly role: Role;
  readonly locale?: EmailLocale | undefined;
}

export interface BuiltEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export function buildInvitationEmail(input: InvitationEmailInput): BuiltEmail {
  const locale: EmailLocale = input.locale ?? 'en';
  const copy = COPY[locale] ?? COPY.en;
  const labels = ROLE_LABELS[locale] ?? ROLE_LABELS.en;
  const roleLabel = labels[input.role];
  const roleLine = copy.roleLine.replace('{role}', roleLabel);
  const url = `${env.app.baseUrl.replace(/\/$/, '')}/invite/${encodeURIComponent(input.token)}`;

  const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <title>${escape(copy.subject)}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 40px auto; padding: 24px; color: #111;">
    <h1 style="font-size: 20px; margin-bottom: 16px;">${escape(copy.heading)}</h1>
    <p style="line-height: 1.6;">${escape(copy.intro)}</p>
    <p style="line-height: 1.6;"><strong>${escape(roleLine)}</strong></p>
    <p style="margin: 24px 0;">
      <a href="${url}" style="display: inline-block; background: #0b6bcb; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px;">${escape(copy.cta)}</a>
    </p>
    <p style="color: #555; font-size: 13px;">${escape(copy.expiryNotice)}</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
    <p style="color: #777; font-size: 12px;">${escape(copy.footer)}</p>
  </body>
</html>`;

  const text =
    `${copy.heading}\n\n` +
    `${copy.intro}\n\n` +
    `${roleLine}\n\n` +
    `${url}\n\n` +
    `${copy.expiryNotice}\n\n` +
    `— ${copy.footer}\n`;

  return { subject: copy.subject, html, text };
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
