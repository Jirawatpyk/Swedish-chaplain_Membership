/** @jsxImportSource react */
/**
 * F8 Phase 7 T200 — Tier-upgrade approval email template.
 *
 * Sent ONCE to the member's primary contact email when an admin
 * Accepts a tier-upgrade suggestion (see `accept-tier-upgrade.ts`).
 * Per FR-039 step 2 (Q5 round 2 pending lifecycle):
 *
 *   "Your upgrade to {target_plan} has been approved; it takes effect
 *    at your next renewal on {expires_at}."
 *
 * Reuses `BaseRenewalLayout` for visual parity with reminder emails.
 * Subject + body copy live in this file (small enough to inline; no
 * tier × offset matrix like the reminder template).
 *
 * Locales: en, th, sv. Thai uses dual-format date (BE + Gregorian) per
 * FR-014; English + Swedish use Gregorian only.
 */
import * as React from 'react';
import { Text } from '@react-email/components';
import { BaseRenewalLayout } from './base-renewal-layout';
import { DualFormatDateFooter } from './dual-format-date-footer';
import type { RenewalEmailLocale } from './copy';

export interface TierUpgradeApprovalEmailProps {
  readonly locale: RenewalEmailLocale;
  readonly memberFirstName: string;
  readonly memberCompanyName: string;
  readonly targetPlanName: string;
  /** ISO 8601 UTC; rendered as-is for en/sv, dual-format for th. */
  readonly effectiveAtIso: string;
  readonly portalUrl: string;
}

interface TierUpgradeApprovalCopy {
  readonly subject: string;
  readonly previewText: string;
  readonly heading: string;
  readonly greeting: string;
  readonly bodyLine1: string;
  readonly bodyLine2: string;
  readonly ctaLabel: string;
}

const COPY: Readonly<Record<RenewalEmailLocale, TierUpgradeApprovalCopy>> = {
  en: {
    subject: 'Your tier upgrade to {planName} has been approved',
    previewText: 'Your upgrade takes effect at your next renewal.',
    heading: 'Your tier upgrade is approved',
    greeting: 'Hello {firstName},',
    bodyLine1:
      'Your chamber administrator has approved an upgrade for {companyName} to the {planName} membership tier.',
    bodyLine2:
      'The upgrade takes effect at your next renewal on {effectiveAt}. No action is required from you today — the next renewal invoice will be issued at the upgraded plan rate.',
    ctaLabel: 'View renewal portal',
  },
  th: {
    subject: 'ยืนยันการปรับระดับสมาชิกเป็น {planName}',
    previewText: 'การปรับระดับจะมีผลในการต่ออายุครั้งถัดไป',
    heading: 'อนุมัติการปรับระดับสมาชิกแล้ว',
    greeting: 'เรียนคุณ{firstName}',
    bodyLine1:
      'ผู้ดูแลของหอการค้าได้อนุมัติการปรับระดับของ{companyName}เป็นสมาชิกระดับ{planName} เรียบร้อย',
    bodyLine2:
      'การปรับระดับจะมีผลในการต่ออายุครั้งถัดไปวันที่ {effectiveAt} โดยไม่ต้องดำเนินการเพิ่มเติม — ใบแจ้งหนี้การต่ออายุครั้งถัดไปจะออกในอัตราใหม่',
    ctaLabel: 'เปิดพอร์ทัลต่ออายุ',
  },
  sv: {
    subject: 'Din nivåhöjning till {planName} har godkänts',
    previewText: 'Uppgraderingen träder i kraft vid nästa förnyelse.',
    heading: 'Din nivåhöjning är godkänd',
    greeting: 'Hej {firstName},',
    bodyLine1:
      'Din kammaradministratör har godkänt en uppgradering för {companyName} till medlemsnivån {planName}.',
    bodyLine2:
      'Uppgraderingen träder i kraft vid din nästa förnyelse den {effectiveAt}. Ingen åtgärd krävs av dig idag — nästa förnyelsefaktura utfärdas till den uppgraderade planens pris.',
    ctaLabel: 'Öppna förnyelseportal',
  },
};

/**
 * Phase 7 review-fix S-types-2: typed interpolation. The closed
 * `CopyVar` union prevents typos at the template-string call site
 * (e.g. `{firstNme}` would now be a TypeScript error against the
 * vars param shape — though the regex still falls through any
 * unknown key to `''` for runtime resilience).
 */
type CopyVar = 'firstName' | 'companyName' | 'planName' | 'effectiveAt';
type CopyVars = Partial<Record<CopyVar, string>>;

function interpolate(template: string, vars: CopyVars): string {
  return template.replace(
    /\{(\w+)\}/g,
    (_match, key: string) => vars[key as CopyVar] ?? '',
  );
}

export function buildTierUpgradeApprovalSubject(
  locale: RenewalEmailLocale,
  vars: { readonly planName: string },
): string {
  return interpolate(COPY[locale].subject, vars);
}

export function TierUpgradeApprovalEmail({
  locale,
  memberFirstName,
  memberCompanyName,
  targetPlanName,
  effectiveAtIso,
  portalUrl,
}: TierUpgradeApprovalEmailProps): React.ReactElement {
  const copy = COPY[locale];
  const effectiveDate = new Date(effectiveAtIso);
  // Phase 7 review-fix S-1 UX: render body date as Gregorian for ALL
  // locales. The dual-format (BE + Gregorian) is the footer's job —
  // duplicating BE in the body for `th` locale created two BE dates
  // per email which is visually noisy and inconsistent with F4
  // reminder-email pattern. Mirrors that precedent.
  const effectiveAtFormatted = effectiveDate.toLocaleDateString(
    locale === 'sv' ? 'sv-SE' : 'en-GB',
    { year: 'numeric', month: 'long', day: 'numeric' },
  );

  const vars = {
    firstName: memberFirstName,
    companyName: memberCompanyName,
    planName: targetPlanName,
    effectiveAt: effectiveAtFormatted,
  };

  return (
    <BaseRenewalLayout
      locale={locale}
      previewText={copy.previewText}
      heading={copy.heading}
      bodyContent={
        <>
          <Text style={{ marginTop: '12px' }}>
            {interpolate(copy.greeting, vars)}
          </Text>
          <Text style={{ marginTop: '12px' }}>
            {interpolate(copy.bodyLine1, vars)}
          </Text>
          <Text style={{ marginTop: '12px' }}>
            {interpolate(copy.bodyLine2, vars)}
          </Text>
        </>
      }
      ctaLabel={copy.ctaLabel}
      ctaHref={portalUrl}
      footer={
        <DualFormatDateFooter locale={locale} expiresAtIso={effectiveAtIso} />
      }
    />
  );
}
