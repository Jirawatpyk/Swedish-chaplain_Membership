/** @jsxImportSource react */
/**
 * F8 Phase 4 Wave I3 / T099 — Dual-format date footer (FR-014).
 *
 * Renders `Expires: {gregorian} / {thaiBE}` in the email footer for
 * ALL locales (en/sv/th) — the dual-format provides cross-confirm
 * defence against the off-by-543-years class of bug noted in spec
 * FR-014 + /speckit.critique round 1 P11.
 *
 * For inline body rendering in the th locale, callers use
 * `formatDualFormatDate()` separately and embed both formats in the
 * paragraph text per FR-014's "th-TH body MUST include dual-format"
 * clause. EN and SV bodies use Gregorian-only inline; the footer
 * still carries dual-format.
 */
import * as React from 'react';
import { Section, Text } from '@react-email/components';
import type { RenewalEmailLocale } from './copy';

export interface DualFormatDateFooterProps {
  readonly locale: RenewalEmailLocale;
  readonly expiresAtIso: string;
}

const FOOTER_STYLE: React.CSSProperties = {
  borderTop: '1px solid #e5e7eb',
  marginTop: '24px',
  paddingTop: '16px',
  fontSize: '12px',
  lineHeight: '1.5',
  color: '#6b7280',
};

/**
 * Per-locale label for the footer. Always renders the dual-format pair.
 */
const LABEL: Record<RenewalEmailLocale, string> = {
  en: 'Expires',
  th: 'หมดอายุ',
  sv: 'Löper ut',
};

export function DualFormatDateFooter({
  locale,
  expiresAtIso,
}: DualFormatDateFooterProps) {
  const { gregorian, thaiBE } = formatDualFormatDate(expiresAtIso, locale);
  return (
    <Section style={FOOTER_STYLE}>
      <Text style={{ margin: 0 }}>
        {LABEL[locale]}: {gregorian} / {thaiBE}
      </Text>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Date formatting helpers (exported for body-text use in renewal-reminder-email.tsx)
// ---------------------------------------------------------------------------

const LOCALE_MAP: Record<RenewalEmailLocale, string> = {
  en: 'en-GB', // 15 August 2026 (day-month-year)
  th: 'th-TH-u-ca-gregory', // Force Gregorian calendar for the EN-equivalent half
  sv: 'sv-SE', // 15 augusti 2026
};

/**
 * Thai BE month abbreviations for the manual BE-formatted half.
 * 0-indexed (Jan = 0).
 */
const THAI_MONTH_ABBR = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

export interface DualFormatDate {
  /** Locale-formatted Gregorian date (e.g., "15 August 2026"). */
  readonly gregorian: string;
  /** Thai Buddhist Era short format (e.g., "15 ส.ค. 2569"). */
  readonly thaiBE: string;
}

/**
 * Format an ISO date string into a dual-format pair (Gregorian +
 * Thai BE). Asia/Bangkok timezone honored to avoid off-by-one-day
 * bugs at midnight UTC boundaries.
 */
export function formatDualFormatDate(
  iso: string,
  locale: RenewalEmailLocale,
): DualFormatDate {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { gregorian: iso, thaiBE: iso };
  }
  // Asia/Bangkok TZ for both halves — ensures member sees the same
  // calendar day regardless of UTC time-of-day.
  const tz = 'Asia/Bangkok';

  const gregorian = new Intl.DateTimeFormat(LOCALE_MAP[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: tz,
  }).format(date);

  // Manual Thai BE format — Intl doesn't have a direct BE calendar
  // for short-month-name output across all environments. Compute via
  // tz-localized date parts.
  const dayBkk = Number(
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: tz }).format(
      date,
    ),
  );
  const monthBkk = Number(
    new Intl.DateTimeFormat('en-GB', {
      month: 'numeric',
      timeZone: tz,
    }).format(date),
  );
  const yearBkk = Number(
    new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: tz }).format(
      date,
    ),
  );
  const beYear = yearBkk + 543;
  const monthIdx = monthBkk - 1;
  const monthAbbr = THAI_MONTH_ABBR[monthIdx] ?? '';
  const thaiBE = `${dayBkk} ${monthAbbr} ${beYear}`;

  return { gregorian, thaiBE };
}
