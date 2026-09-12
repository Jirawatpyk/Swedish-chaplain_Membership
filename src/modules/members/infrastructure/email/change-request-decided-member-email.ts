/**
 * F114 — the member "your request was decided" email (FR-023; contracts/
 * notifications-and-audit.md § 1). Rendered AT SEND TIME by the outbox
 * dispatcher from the request rows (research R8 / § V3) — the outbox row
 * carries ids only.
 *
 * Content: the outcome; the fields that are now live; the fields that were
 * not approved with the reviewer's reason VERBATIM but escaped — never
 * markup, never auto-linked; a link to the resubmit form when anything was
 * rejected. The reviewer is never named: the decision comes from the
 * organisation (FR-023).
 */
import { env } from '@/lib/env';
import { escapeHtml } from '@/lib/html-escape';
import { EMAIL_BRAND_PRIMARY, emailLogoUrl } from '@/lib/email-brand';
import type { ChangeRequestOutcome, FieldOutcome, ProposedValue } from '../../domain/change-request/change-request';
import type { ProposableFieldKey } from '../../domain/change-request/proposable-fields';
import {
  formatSubmittedAt,
  renderValueText,
  type BuiltEmail,
  type EmailLocale,
} from './change-request-submitted-staff-email';

export interface ChangeRequestDecidedEmailField {
  readonly key: ProposableFieldKey;
  readonly proposed: ProposedValue;
  readonly outcome: FieldOutcome;
}

export interface ChangeRequestDecidedMemberEmailInput {
  readonly locale: EmailLocale;
  readonly requestId: string;
  readonly outcome: ChangeRequestOutcome;
  readonly decidedAt: Date;
  /** The reviewer's reason, plain text; null when nothing was rejected. */
  readonly reason: string | null;
  readonly fields: readonly ChangeRequestDecidedEmailField[];
  /** Accepted for symmetry with the staff email input and deliberately NOT rendered. */
  readonly reviewerName?: string;
}

interface Copy {
  readonly subject: Record<ChangeRequestOutcome, string>;
  readonly heading: Record<ChangeRequestOutcome, string>;
  readonly intro: Record<ChangeRequestOutcome, string>;
  readonly decidedAt: string;
  readonly applied: string;
  readonly notApplied: string;
  readonly reasonLabel: string;
  readonly resubmit: string;
  readonly cta: string;
  readonly empty: string;
  readonly footer: string;
  readonly fieldLabels: Record<ProposableFieldKey, string>;
}

const COPY: Record<EmailLocale, Copy> = {
  en: {
    subject: {
      approved: '[SweCham] Your change request was approved',
      partially_approved: '[SweCham] Your change request was partially approved',
      rejected: '[SweCham] Your change request was not approved',
    },
    heading: {
      approved: 'Your changes are now live',
      partially_approved: 'Some of your changes are now live',
      rejected: 'Your changes were not approved',
    },
    intro: {
      approved: 'SweCham reviewed your request and applied every change to your member record.',
      partially_approved: 'SweCham reviewed your request. The changes below were applied; the rest were not.',
      rejected: 'SweCham reviewed your request and did not apply the changes below.',
    },
    decidedAt: 'Decided',
    applied: 'Now live',
    notApplied: 'Not approved',
    reasonLabel: 'Reason from SweCham',
    resubmit: 'You can adjust the values that were not approved and submit them again.',
    cta: 'Edit and resubmit',
    empty: '(empty)',
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
  },
  th: {
    subject: {
      approved: '[SweCham] คำขอแก้ไขข้อมูลของคุณได้รับการอนุมัติแล้ว',
      partially_approved: '[SweCham] คำขอแก้ไขข้อมูลของคุณได้รับการอนุมัติบางส่วน',
      rejected: '[SweCham] คำขอแก้ไขข้อมูลของคุณไม่ได้รับการอนุมัติ',
    },
    heading: {
      approved: 'ข้อมูลของคุณถูกอัปเดตแล้ว',
      partially_approved: 'ข้อมูลบางส่วนของคุณถูกอัปเดตแล้ว',
      rejected: 'คำขอของคุณไม่ได้รับการอนุมัติ',
    },
    intro: {
      approved: 'SweCham ได้ตรวจสอบคำขอของคุณและบันทึกการเปลี่ยนแปลงทั้งหมดลงในข้อมูลสมาชิกแล้ว',
      partially_approved: 'SweCham ได้ตรวจสอบคำขอของคุณ รายการด้านล่างถูกบันทึกแล้ว ส่วนที่เหลือไม่ได้รับการอนุมัติ',
      rejected: 'SweCham ได้ตรวจสอบคำขอของคุณและไม่ได้บันทึกรายการด้านล่าง',
    },
    decidedAt: 'ตัดสินเมื่อ',
    applied: 'บันทึกแล้ว',
    notApplied: 'ไม่ได้รับการอนุมัติ',
    reasonLabel: 'เหตุผลจาก SweCham',
    resubmit: 'คุณสามารถปรับค่าที่ไม่ได้รับการอนุมัติแล้วส่งใหม่อีกครั้งได้',
    cta: 'แก้ไขและส่งใหม่',
    empty: '(ว่าง)',
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
      billing_address: 'ที่อยู่สำหรับออกใบกำกับ',
    },
  },
  sv: {
    subject: {
      approved: '[SweCham] Din ändringsbegäran har godkänts',
      partially_approved: '[SweCham] Din ändringsbegäran har delvis godkänts',
      rejected: '[SweCham] Din ändringsbegäran godkändes inte',
    },
    heading: {
      approved: 'Dina ändringar är nu införda',
      partially_approved: 'Några av dina ändringar är nu införda',
      rejected: 'Dina ändringar godkändes inte',
    },
    intro: {
      approved: 'SweCham har granskat din begäran och infört alla ändringar i dina medlemsuppgifter.',
      partially_approved: 'SweCham har granskat din begäran. Ändringarna nedan infördes; övriga godkändes inte.',
      rejected: 'SweCham har granskat din begäran och införde inte ändringarna nedan.',
    },
    decidedAt: 'Beslutat',
    applied: 'Nu infört',
    notApplied: 'Inte godkänt',
    reasonLabel: 'Motivering från SweCham',
    resubmit: 'Du kan justera de värden som inte godkändes och skicka in dem igen.',
    cta: 'Redigera och skicka igen',
    empty: '(tomt)',
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
  },
};

export function resubmitLinkFor(requestId: string): string {
  return `${env.app.baseUrl.replace(/\/$/, '')}/portal/edit?resubmit=${encodeURIComponent(requestId)}`;
}

export function buildChangeRequestDecidedMemberEmail(input: ChangeRequestDecidedMemberEmailInput): BuiltEmail {
  const copy = COPY[input.locale] ?? COPY.en;
  // `renderValueText` takes the staff-email copy shape; only `empty` is read.
  const valueCopy = { empty: copy.empty } as Parameters<typeof renderValueText>[1];
  const subject = copy.subject[input.outcome];
  const when = formatSubmittedAt(input.decidedAt, input.locale);
  const applied = input.fields.filter((f) => f.outcome === 'approved');
  const notApplied = input.fields.filter((f) => f.outcome === 'rejected');
  const url = notApplied.length > 0 ? resubmitLinkFor(input.requestId) : null;
  const reason = input.reason !== null && input.reason.trim() !== '' ? input.reason.trim() : null;

  const rowHtml = (f: ChangeRequestDecidedEmailField) =>
    `<tr>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top;"><strong>${escapeHtml(copy.fieldLabels[f.key])}</strong></td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top;">${escapeHtml(renderValueText(f.proposed, valueCopy))}</td>
      </tr>`;
  const rowText = (f: ChangeRequestDecidedEmailField) => `- ${copy.fieldLabels[f.key]}: ${renderValueText(f.proposed, valueCopy)}`;

  const section = (title: string, rows: readonly ChangeRequestDecidedEmailField[]) =>
    rows.length === 0
      ? ''
      : `<h2 style="font-size: 16px; margin: 24px 0 8px;">${escapeHtml(title)}</h2>
    <table role="presentation" style="border-collapse: collapse; width: 100%; font-size: 14px;">
      ${rows.map(rowHtml).join('\n')}
    </table>`;

  const reasonHtml = reason === null
    ? ''
    : `<p style="line-height: 1.6; margin: 16px 0; padding: 12px 16px; background: #f6f6f6; border-left: 3px solid ${EMAIL_BRAND_PRIMARY};">
      <strong>${escapeHtml(copy.reasonLabel)}:</strong><br />
      <span style="white-space: pre-wrap;">${escapeHtml(reason)}</span>
    </p>`;

  const ctaHtml = url === null
    ? ''
    : `<p style="line-height: 1.6;">${escapeHtml(copy.resubmit)}</p>
    <p style="margin: 24px 0;">
      <a href="${url}" style="display: inline-block; background: ${EMAIL_BRAND_PRIMARY}; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 6px;">${escapeHtml(copy.cta)}</a>
    </p>`;

  const html = `<!doctype html>
<html lang="${input.locale}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 40px auto; padding: 24px; color: #111;">
    <img src="${emailLogoUrl()}" alt="SweCham — Thai-Swedish Chamber of Commerce" width="200" style="display: block; border: 0; height: auto; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #eee;" />
    <h1 style="font-size: 20px; margin-bottom: 16px;">${escapeHtml(copy.heading[input.outcome])}</h1>
    <p style="line-height: 1.6;">${escapeHtml(copy.intro[input.outcome])}</p>
    <p style="line-height: 1.8; margin: 16px 0;"><strong>${escapeHtml(copy.decidedAt)}:</strong> ${escapeHtml(when)}</p>
    ${section(copy.applied, applied)}
    ${section(copy.notApplied, notApplied)}
    ${reasonHtml}
    ${ctaHtml}
    <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
    <p style="color: #777; font-size: 12px;">${escapeHtml(copy.footer)}</p>
  </body>
</html>`;

  const textSections: string[] = [];
  if (applied.length > 0) textSections.push(`${copy.applied}:\n${applied.map(rowText).join('\n')}`);
  if (notApplied.length > 0) textSections.push(`${copy.notApplied}:\n${notApplied.map(rowText).join('\n')}`);
  if (reason !== null) textSections.push(`${copy.reasonLabel}:\n${reason}`);
  if (url !== null) textSections.push(`${copy.resubmit}\n${copy.cta}: ${url}`);

  const text =
    `${copy.heading[input.outcome]}\n\n` +
    `${copy.intro[input.outcome]}\n\n` +
    `${copy.decidedAt}: ${when}\n\n` +
    textSections.join('\n\n') +
    `\n\n— ${copy.footer}\n`;

  return { subject, html, text };
}
