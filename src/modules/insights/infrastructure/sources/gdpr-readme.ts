/**
 * F9 US6 (T094 / FR-029) — localised GDPR archive README.
 *
 * The README is rendered in the REQUESTER's locale (the member's own, or the
 * admin's for an on-behalf request), with EN fallback. The `manifest.json` is
 * locale-neutral (English keys) — see the zip builder.
 *
 * Reads the static next-intl message JSON directly (no request context needed —
 * the worker runs in a cron with no locale-bound request), so it is
 * deterministic + unit-testable. Importing the message bundle into the worker
 * route is fine (it is server-only; `check:bundle-budgets` covers client
 * bundles, not the cron).
 */
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import { isLocale, type Locale } from '@/i18n/config';

type ReadmeStrings = (typeof enMessages)['gdprExport']['readme'];

const BUNDLES: Record<Locale, ReadmeStrings> = {
  en: enMessages.gdprExport.readme,
  th: thMessages.gdprExport.readme,
  sv: svMessages.gdprExport.readme,
};

function interpolate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? `{${key}}`);
}

export interface GdprReadmeVars {
  readonly tenantName: string;
  readonly generatedAtIso: string;
  readonly memberId: string;
}

/**
 * Build the plain-text README for the requester's locale (EN fallback for an
 * unknown/unsupported locale code).
 */
export function buildGdprReadme(locale: string, vars: GdprReadmeVars): string {
  const r = BUNDLES[isLocale(locale) ? locale : 'en'];
  const lines: string[] = [
    r.title,
    '='.repeat(r.title.length),
    '',
    interpolate(r.intro, { tenant: vars.tenantName, generatedAt: vars.generatedAtIso }),
    '',
    interpolate(r.subjectLine, { memberId: vars.memberId }),
    '',
    r.filesHeading,
    '-'.repeat(r.filesHeading.length),
    `- ${r.files.profile}`,
    `- ${r.files.contacts}`,
    `- ${r.files.invoices}`,
    `- ${r.files.events}`,
    `- ${r.files.broadcasts}`,
    `- ${r.files.auditEvents}`,
    `- ${r.files.manifest}`,
    '',
    r.privacyNote,
    '',
  ];
  return lines.join('\n');
}
