/**
 * F114 — the staff "who changed what" email (FR-011; contracts/notifications-
 * and-audit.md § 1). One copy per reviewer, rendered AT SEND TIME by the outbox
 * dispatcher from the request rows (research R8 / § V3) — the outbox row
 * carries ids and field keys only, so a scrubbed request renders scrubbed and
 * a sent row holds no PII.
 *
 * Follows the members plain-HTML-builder pattern (email-verification-email.ts):
 * hand-built HTML, `escapeHtml` on EVERY value, brand helpers, three locales.
 * The review link opens the submitter's CURRENT pending request
 * (`?submitter=<userId>&state=pending`) — never a request id — so a link from
 * a superseded email lands on the live values (FR-011 coalescing).
 */
import { env } from '@/lib/env';
import { escapeHtml } from '@/lib/html-escape';
import { EMAIL_BRAND_PRIMARY, emailLogoUrl } from '@/lib/email-brand';
import type { ProposedValue, SubmitterRole } from '../../domain/change-request/change-request';
import {
  BILLING_ADDRESS_LINES,
  REGISTERED_ADDRESS_LINES,
  type ProposableFieldKey,
} from '../../domain/change-request/proposable-fields';

export type EmailLocale = 'en' | 'th' | 'sv';

export interface ChangeRequestEmailField {
  readonly key: ProposableFieldKey;
  readonly current: ProposedValue;
  readonly proposed: ProposedValue;
  readonly affectsTaxDocuments: boolean;
}

export interface ChangeRequestSubmittedStaffEmailInput {
  readonly locale: EmailLocale;
  readonly companyName: string;
  /** Already formatted (`SCCM-0042`). */
  readonly memberNumber: string;
  readonly submitterName: string;
  readonly submitterRole: SubmitterRole;
  readonly submittedAt: Date;
  readonly submitterUserId: string;
  readonly fields: readonly ChangeRequestEmailField[];
}

export interface BuiltEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface Copy {
  readonly subject: (company: string, memberNumber: string) => string;
  readonly heading: string;
  readonly intro: string;
  readonly member: string;
  readonly submittedBy: string;
  readonly submittedAt: string;
  readonly roles: Record<SubmitterRole, string>;
  readonly changes: string;
  readonly empty: string;
  readonly taxMarker: string;
  readonly cta: string;
  readonly footer: string;
  readonly fieldLabels: Record<ProposableFieldKey, string>;
  readonly addressLines: Record<(typeof BILLING_ADDRESS_LINES)[number], string>;
}

const COPY: Record<EmailLocale, Copy> = {
  en: {
    subject: (company, memberNumber) => `[SweCham] Change request — ${company} (${memberNumber})`,
    heading: 'A member proposed changes to their record',
    intro: 'Nothing has been applied yet. Review the proposal and approve or reject each field.',
    member: 'Member',
    submittedBy: 'Submitted by',
    submittedAt: 'Submitted',
    roles: { primary: 'primary contact', secondary: 'secondary contact' },
    changes: 'Proposed changes',
    empty: '(empty)',
    taxMarker: 'affects tax documents',
    cta: 'Review the request',
    footer: 'Thai-Swedish Chamber of Commerce (SweCham / TSCC)',
    fieldLabels: {
      first_name: 'First name',
      last_name: 'Last name',
      phone: 'Phone',
      role_title: 'Job title',
      company_name: 'Company name',
      website: 'Website',
      description: 'Description',
      registered_address: 'Registered address',
      billing_address: 'Billing address',
    },
    addressLines: {
      line1: 'Address line 1',
      line2: 'Address line 2',
      sub_district: 'Sub-district',
      city: 'City',
      province: 'Province',
      postal_code: 'Postal code',
      country: 'Country',
    },
  },
  th: {
    subject: (company, memberNumber) => `[SweCham] คำขอแก้ไขข้อมูล — ${company} (${memberNumber})`,
    heading: 'สมาชิกเสนอแก้ไขข้อมูลของตนเอง',
    intro: 'ยังไม่มีการเปลี่ยนแปลงใดถูกบันทึก โปรดตรวจสอบและอนุมัติหรือปฏิเสธเป็นรายฟิลด์',
    member: 'สมาชิก',
    submittedBy: 'ส่งโดย',
    submittedAt: 'ส่งเมื่อ',
    roles: { primary: 'ผู้ติดต่อหลัก', secondary: 'ผู้ติดต่อรอง' },
    changes: 'รายการที่เสนอแก้ไข',
    empty: '(ว่าง)',
    taxMarker: 'มีผลต่อเอกสารภาษี',
    cta: 'ตรวจสอบคำขอ',
    footer: 'หอการค้าไทย-สวีเดน (SweCham / TSCC)',
    fieldLabels: {
      first_name: 'ชื่อ',
      last_name: 'นามสกุล',
      phone: 'โทรศัพท์',
      role_title: 'ตำแหน่ง',
      company_name: 'ชื่อบริษัท',
      website: 'เว็บไซต์',
      description: 'คำอธิบาย',
      registered_address: 'ที่อยู่จดทะเบียน',
      billing_address: 'ที่อยู่ออกใบแจ้งหนี้',
    },
    addressLines: {
      line1: 'ที่อยู่บรรทัด 1',
      line2: 'ที่อยู่บรรทัด 2',
      sub_district: 'แขวง/ตำบล',
      city: 'เขต/อำเภอ',
      province: 'จังหวัด',
      postal_code: 'รหัสไปรษณีย์',
      country: 'ประเทศ',
    },
  },
  sv: {
    subject: (company, memberNumber) => `[SweCham] Ändringsbegäran — ${company} (${memberNumber})`,
    heading: 'En medlem har föreslagit ändringar i sina uppgifter',
    intro: 'Inget har tillämpats ännu. Granska förslaget och godkänn eller avslå varje fält.',
    member: 'Medlem',
    submittedBy: 'Inskickat av',
    submittedAt: 'Inskickat',
    roles: { primary: 'primär kontakt', secondary: 'sekundär kontakt' },
    changes: 'Föreslagna ändringar',
    empty: '(tomt)',
    taxMarker: 'påverkar skattedokument',
    cta: 'Granska begäran',
    footer: 'Thai-Swedish Chamber of Commerce (SweCham / TSCC)',
    fieldLabels: {
      first_name: 'Förnamn',
      last_name: 'Efternamn',
      phone: 'Telefon',
      role_title: 'Befattning',
      company_name: 'Företagsnamn',
      website: 'Webbplats',
      description: 'Beskrivning',
      registered_address: 'Registrerad adress',
      billing_address: 'Faktureringsadress',
    },
    addressLines: {
      line1: 'Adressrad 1',
      line2: 'Adressrad 2',
      sub_district: 'Stadsdel',
      city: 'Stad',
      province: 'Provins',
      postal_code: 'Postnummer',
      country: 'Land',
    },
  },
};

function isAddress(v: ProposedValue): v is Exclude<ProposedValue, string | null> {
  return v !== null && typeof v === 'object';
}

/** A value as plain text: scalar, `(empty)`, or the address lines joined with `, `. */
export function renderValueText(value: ProposedValue, copy: Copy): string {
  if (value === null) return copy.empty;
  if (!isAddress(value)) return value === '' ? copy.empty : value;
  const lines = ('country' in value ? BILLING_ADDRESS_LINES : REGISTERED_ADDRESS_LINES) as readonly string[];
  const parts = lines
    .map((line) => (value as Readonly<Record<string, string | null>>)[line] ?? null)
    .filter((v): v is string => v !== null && v !== '');
  return parts.length === 0 ? copy.empty : parts.join(', ');
}

export function formatSubmittedAt(at: Date, locale: EmailLocale): string {
  const tag = locale === 'th' ? 'th-TH' : locale === 'sv' ? 'sv-SE' : 'en-GB';
  return new Intl.DateTimeFormat(tag, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(at);
}

export function reviewLinkFor(submitterUserId: string): string {
  return `${env.app.baseUrl.replace(/\/$/, '')}/admin/change-requests?submitter=${encodeURIComponent(submitterUserId)}&state=pending`;
}

export function buildChangeRequestSubmittedStaffEmail(input: ChangeRequestSubmittedStaffEmailInput): BuiltEmail {
  const copy = COPY[input.locale] ?? COPY.en;
  const subject = copy.subject(input.companyName, input.memberNumber);
  const url = reviewLinkFor(input.submitterUserId);
  const when = formatSubmittedAt(input.submittedAt, input.locale);
  const role = copy.roles[input.submitterRole];

  const rowsText = input.fields.map((f) => {
    const label = copy.fieldLabels[f.key];
    const line = `${label}: ${renderValueText(f.current, copy)} → ${renderValueText(f.proposed, copy)}`;
    return f.affectsTaxDocuments ? `${line} [${copy.taxMarker}]` : line;
  });

  const rowsHtml = input.fields
    .map((f) => {
      const label = escapeHtml(copy.fieldLabels[f.key]);
      const marker = f.affectsTaxDocuments
        ? ` <span style="color: #92400e; font-size: 12px;">&#9888; ${escapeHtml(copy.taxMarker)}</span>`
        : '';
      return `<tr>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top;"><strong>${label}</strong>${marker}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; color: #555;">${escapeHtml(renderValueText(f.current, copy))}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top;">${escapeHtml(renderValueText(f.proposed, copy))}</td>
      </tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="${input.locale}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 40px auto; padding: 24px; color: #111;">
    <img src="${emailLogoUrl()}" alt="SweCham — Thai-Swedish Chamber of Commerce" width="200" style="display: block; border: 0; height: auto; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #eee;" />
    <h1 style="font-size: 20px; margin-bottom: 16px;">${escapeHtml(copy.heading)}</h1>
    <p style="line-height: 1.6;">${escapeHtml(copy.intro)}</p>
    <p style="line-height: 1.8; margin: 16px 0;">
      <strong>${escapeHtml(copy.member)}:</strong> ${escapeHtml(input.companyName)} (${escapeHtml(input.memberNumber)})<br />
      <strong>${escapeHtml(copy.submittedBy)}:</strong> ${escapeHtml(input.submitterName)} (${escapeHtml(role)})<br />
      <strong>${escapeHtml(copy.submittedAt)}:</strong> ${escapeHtml(when)}
    </p>
    <h2 style="font-size: 16px; margin: 24px 0 8px;">${escapeHtml(copy.changes)}</h2>
    <table role="presentation" style="border-collapse: collapse; width: 100%; font-size: 14px;">
      ${rowsHtml}
    </table>
    <p style="margin: 24px 0;">
      <a href="${url}" style="display: inline-block; background: ${EMAIL_BRAND_PRIMARY}; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px;">${escapeHtml(copy.cta)}</a>
    </p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
    <p style="color: #777; font-size: 12px;">${escapeHtml(copy.footer)}</p>
  </body>
</html>`;

  const text =
    `${copy.heading}\n\n` +
    `${copy.intro}\n\n` +
    `${copy.member}: ${input.companyName} (${input.memberNumber})\n` +
    `${copy.submittedBy}: ${input.submitterName} (${role})\n` +
    `${copy.submittedAt}: ${when}\n\n` +
    `${copy.changes}:\n` +
    rowsText.map((r) => `- ${r}`).join('\n') +
    `\n\n${copy.cta}: ${url}\n\n` +
    `— ${copy.footer}\n`;

  return { subject, html, text };
}
