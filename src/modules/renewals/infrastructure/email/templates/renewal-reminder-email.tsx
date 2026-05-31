/** @jsxImportSource react */
/**
 * F8 Phase 4 Wave I3 / T093-T098 — Generic reminder email template.
 *
 * ONE template covers all (tier × offset_day × locale) combinations
 * by reading copy from `copy.ts` and interpolating placeholders. The
 * tasks.md prescription (1 file per tier × offset) was rejected in
 * favour of this design (see plan file for rationale): visual chrome
 * is identical across all reminders; only text varies.
 *
 * Usage (by `resend-transactional-renewal-gateway.ts`):
 *
 *   const html = await render(
 *     <RenewalReminderEmail
 *       locale="th"
 *       tier="thai_alumni"
 *       offset="t-30"
 *       memberFirstName="Somchai"
 *       memberCompanyName="Acme Co"
 *       expiresAtIso="2026-08-15T00:00:00Z"
 *       daysUntilExpiry={30}
 *       renewalLinkUrl="https://swecham.zyncdata.app/portal/renewal/{member_id}?token=…"
 *     />
 *   );
 *
 * FR-014 inline dual-format for th-locale: the template embeds the
 * dual-format date directly into the body via `interpolateCopy` —
 * the gateway resolves `{expiresAt}` to either Gregorian-only (en/sv)
 * or `"15 ส.ค. 2569 (15 August 2026)"` (th) before passing to render.
 */
import * as React from 'react';
import { BaseRenewalLayout } from './base-renewal-layout';
import {
  DualFormatDateFooter,
  formatDualFormatDate,
} from './dual-format-date-footer';
import {
  interpolateCopy,
  resolveCopy,
  TIER_LABELS,
  type RenewalEmailLocale,
  type RenewalReminderOffset,
  type RenewalReminderTier,
} from './copy';

export interface RenewalReminderEmailProps {
  readonly locale: RenewalEmailLocale;
  readonly tier: RenewalReminderTier;
  readonly offset: RenewalReminderOffset;
  readonly memberFirstName: string;
  readonly memberCompanyName: string;
  readonly expiresAtIso: string;
  readonly daysUntilExpiry: number;
  readonly renewalLinkUrl: string;
  /** S1-P1-3 — opt-out/manage-preferences URL for the footer link. */
  readonly preferencesUrl?: string;
}

/**
 * Build the {expiresAt} placeholder value per locale. For th, the
 * inline body shows BOTH Thai BE + Gregorian per FR-014; for en/sv
 * the body shows Gregorian only (the footer carries the dual-format
 * cross-confirm pair regardless of locale).
 */
function buildExpiresAtForBody(
  iso: string,
  locale: RenewalEmailLocale,
): string {
  const { gregorian, thaiBE } = formatDualFormatDate(iso, locale);
  if (locale === 'th') {
    return `${thaiBE} (${gregorian})`;
  }
  return gregorian;
}

export function RenewalReminderEmail(props: RenewalReminderEmailProps) {
  const { copy } = resolveCopy(props.tier, props.offset, props.locale);
  const tierLabel = TIER_LABELS[props.locale][props.tier];
  const expiresAtFormatted = buildExpiresAtForBody(
    props.expiresAtIso,
    props.locale,
  );
  const variables: Record<string, string | number> = {
    firstName: props.memberFirstName,
    companyName: props.memberCompanyName,
    tier: tierLabel,
    daysUntilExpiry: Math.abs(props.daysUntilExpiry),
    expiresAt: expiresAtFormatted,
  };
  const subject = interpolateCopy(copy.subject, variables);
  const body = interpolateCopy(copy.body, variables);
  // CTA label has no placeholders typically, but interpolate for safety.
  const ctaLabel = interpolateCopy(copy.cta, variables);

  return (
    <BaseRenewalLayout
      locale={props.locale}
      previewText={subject}
      heading={subject}
      bodyContent={body}
      ctaLabel={ctaLabel}
      ctaHref={props.renewalLinkUrl}
      {...(props.preferencesUrl ? { preferencesUrl: props.preferencesUrl } : {})}
      footer={
        <DualFormatDateFooter
          locale={props.locale}
          expiresAtIso={props.expiresAtIso}
        />
      }
    />
  );
}
