import type { useTranslations } from 'next-intl';

/**
 * Localise the 422 validation-warning `details` payload for
 * OverrideReasonDialog.
 *
 * The create/edit member clients used to pass `JSON.stringify(details)` as
 * the dialog's warning text, leaking a raw server object to the admin
 * (e.g. `{"type":"turnover_out_of_band","turnoverThb":500000,...}`) — a
 * ux-standards.md § 4.4 violation ("never expose raw server messages").
 * This turns the structured payload into a readable, translated sentence.
 *
 * The `details` shape mirrors the create-member / change-plan use-case
 * error objects surfaced by the API routes (each carries a `type`
 * discriminator). Unknown / malformed payloads fall back to a generic
 * message so the admin still gets actionable copy.
 */

type OverrideT = ReturnType<
  typeof useTranslations<'admin.members.overrideReason'>
>;

type OverrideWarningDetails = {
  readonly type?: string;
  readonly turnoverThb?: number;
  readonly band?: {
    readonly minThb?: number | null;
    readonly maxThb?: number | null;
  };
  readonly foundedYear?: number;
  readonly maxAllowedYears?: number;
  readonly ageYears?: number;
  readonly maxAge?: number;
};

/** Thousands-grouped string, or '' when the value is absent. */
function group(n: number | null | undefined): string {
  return typeof n === 'number' ? new Intl.NumberFormat().format(n) : '';
}

export function formatOverrideWarning(details: unknown, t: OverrideT): string {
  const d = (details ?? {}) as OverrideWarningDetails;
  switch (d.type) {
    case 'turnover_out_of_band': {
      const turnover = group(d.turnoverThb);
      const min = group(d.band?.minThb);
      const max = group(d.band?.maxThb);
      if (min && max) {
        return t('warnings.turnoverOutOfBand', { turnover, min, max });
      }
      if (min) return t('warnings.turnoverBelow', { turnover, min });
      if (max) return t('warnings.turnoverAbove', { turnover, max });
      return t('warnings.generic');
    }
    case 'startup_too_old':
      return t('warnings.startupTooOld', {
        year: String(d.foundedYear ?? ''),
        maxYears: String(d.maxAllowedYears ?? ''),
      });
    case 'age_not_eligible':
      return t('warnings.ageNotEligible', {
        age: String(d.ageYears ?? ''),
        maxAge: String(d.maxAge ?? ''),
      });
    default:
      return t('warnings.generic');
  }
}
